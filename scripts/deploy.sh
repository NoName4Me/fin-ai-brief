#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ENV_FILE=${DEPLOY_ENV_FILE:-$ROOT/deploy/.env}
STATE_DIR=${DEPLOY_STATE_DIR:-$ROOT/deploy/.state}
BACKUP_DIR=${DEPLOY_BACKUP_DIR:-$ROOT/deploy/backups}
BACKUP_RETENTION_DAYS=${DEPLOY_BACKUP_RETENTION_DAYS:-14}
PROJECT=${DEPLOY_PROJECT:-fin-ai-brief}
mkdir -p "$STATE_DIR" "$BACKUP_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

usage() {
  echo '用法: scripts/deploy.sh init HTTP_PORT | deploy | status | logs [service] | backup | load [RELEASE_DIR] | restore FILE VERSION --confirm | stop'
}
if [[ ${1:-} == init ]]; then
  python3 deploy/config.py init "$ENV_FILE" "${@:2}"
  exit
fi
[[ $# -ge 1 ]] || { usage; exit 1; }
python3 deploy/config.py validate "$ENV_FILE"
command -v docker >/dev/null
[[ $BACKUP_RETENTION_DAYS =~ ^[0-9]+$ ]] || {
  echo 'DEPLOY_BACKUP_RETENTION_DAYS 必须是非负整数' >&2
  exit 1
}
release_value() { python3 deploy/config.py release-value "$ROOT" "$1"; }
export APP_VERSION=${APP_VERSION:-$(cat "$STATE_DIR/current" 2>/dev/null || release_value version)}
infrastructure_image() {
  local state_name=$1 manifest_key=$2 value
  value=$(cat "$STATE_DIR/$state_name" 2>/dev/null || true)
  if [[ -z $value ]]; then value=$(release_value "$manifest_key"); fi
  if [[ -z $value ]]; then
    echo '更新包需要已部署的服务器；首次安装或新机恢复请用 package-release.sh --full 生成完整包。' >&2
    return 1
  fi
  printf '%s\n' "$value"
}
POSTGRES_IMAGE=$(infrastructure_image postgres-image postgres_image)
NGINX_IMAGE=$(infrastructure_image nginx-image nginx_image)
export POSTGRES_IMAGE NGINX_IMAGE
compose() { docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f deploy/compose.yaml "$@"; }
compose config --quiet
CUTOVER=0
on_error() {
  local code=$?
  trap - ERR
  if [[ $CUTOVER == 1 ]]; then compose stop nginx web worker || true; fi
  echo '操作失败；应用未自动回退。请查看日志，修复后重试，或按文档恢复备份。' >&2
  exit "$code"
}
trap on_error ERR
# Prevent overlapping releases, backups and restores from separate terminals or cron.
command -v flock >/dev/null || { echo '请安装 util-linux（需要 flock）' >&2; exit 1; }
if [[ $1 != status && $1 != logs ]]; then
  exec 9>"$STATE_DIR/operation.lock"
  flock -n 9 || { echo '已有部署或备份任务运行中' >&2; exit 1; }
fi

backup() {
  local stamp file
  stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
  file="$BACKUP_DIR/$stamp.dump"
  log '[备份] 正在导出数据库（耗时取决于数据量）…'
  if ! compose exec -T db pg_dump -U finbrief -d fin_ai_brief --format=custom --no-owner --no-acl > "$file.tmp"; then
    rm -f "$file.tmp"
    return 1
  fi
  log '[备份] 正在校验备份文件…'
  if ! compose exec -T db pg_restore --list < "$file.tmp" >/dev/null; then
    rm -f "$file.tmp"
    return 1
  fi
  mv "$file.tmp" "$file"
  cp "$ENV_FILE" "$BACKUP_DIR/$stamp.env"
  cat "$STATE_DIR/current" 2>/dev/null > "$BACKUP_DIR/$stamp.version" || echo bootstrap > "$BACKUP_DIR/$stamp.version"
  log "[备份] 备份完成：$file"
  prune_backups
}
prune_backups() {
  local older base removed=0
  if ((BACKUP_RETENTION_DAYS == 0)); then
    log '[备份] 自动清理已关闭，旧备份保留不删'
    return
  fi
  while IFS= read -r -d '' older; do
    base=${older%.dump}
    rm -f "$older" "$base.env" "$base.version"
    removed=$((removed + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -mtime +$((BACKUP_RETENTION_DAYS - 1)) -print0)
  if ((removed > 0)); then
    log "[备份] 已清理 ${BACKUP_RETENTION_DAYS} 天前的 $removed 份数据库备份"
  else
    log "[备份] 保留最近 ${BACKUP_RETENTION_DAYS} 天的数据库备份"
  fi
}
start_apps() {
  log '[启动] 启动 Web 和 Worker，等待健康检查（最多 180 秒）…'
  compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 web worker
  # Reuse Nginx unless Compose detects a configuration/image change. Reload resolves
  # the new Web container address and applies any changed bind-mounted template.
  log '[启动] 检查 Nginx 并重新加载入口配置…'
  compose up -d --no-deps --no-build --pull never --wait --wait-timeout 90 nginx
  compose exec -T nginx sh -ec '/docker-entrypoint.d/20-envsubst-on-templates.sh; nginx -t; nginx -s reload'
  printf '%s\n' "$APP_VERSION" > "$STATE_DIR/current.tmp"
  mv "$STATE_DIR/current.tmp" "$STATE_DIR/current"
  printf '%s\n' "$NGINX_IMAGE" > "$STATE_DIR/nginx-image"
  CUTOVER=0
  compose ps
  log '[启动] Web、Worker 和 Nginx 健康检查通过'
}
require_images() {
  docker image inspect "fin-ai-brief-web:$APP_VERSION" "fin-ai-brief-worker:$APP_VERSION" >/dev/null
}
load_release() {
  local directory=$1 platform expected
  log "[镜像] 校验部署包：$directory"
  python3 deploy/config.py verify-release "$directory"
  expected=$(python3 deploy/config.py release-value "$directory" platform)
  platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
  case "$platform" in linux/x86_64) platform=linux/amd64 ;; linux/aarch64) platform=linux/arm64 ;; esac
  [[ $platform == "$expected" ]] || { echo "部署包平台为 ${expected}，服务器平台为 ${platform}，请重新打包" >&2; return 1; }
  log "[镜像] 平台校验通过（${expected}），开始加载镜像；大包可能需要数分钟…"
  docker image load -i "$directory/release/images.tar"
  log '[镜像] 镜像加载完成'
}
start_db() {
  # Database image upgrades are separate maintenance, never an incidental app release.
  log '[数据库] 启动并检查现有数据库容器（最多 120 秒）…'
  compose up -d --no-recreate --pull never --wait --wait-timeout 120 db
  local id
  id=$(compose ps -q db)
  export POSTGRES_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$id")
  printf '%s\n' "$POSTGRES_IMAGE" > "$STATE_DIR/postgres-image"
  log '[数据库] 数据库容器已就绪'
}

case "$1" in
  deploy)
    log '[部署 1/8] 校验部署包并加载镜像'
    load_release "$ROOT"
    export APP_VERSION=$(release_value version)
    if [[ $(release_value mode) == full ]]; then
      NGINX_IMAGE=$(release_value nginx_image)
    fi
    log '[部署 2/8] 校验应用和基础镜像'
    require_images
    # Fail before stopping applications if an update has lost its base images.
    docker image inspect "$POSTGRES_IMAGE" "$NGINX_IMAGE" >/dev/null
    log "[部署] 目标版本：$APP_VERSION"
    log '[部署 3/8] 准备数据库容器'
    start_db
    CUTOVER=1
    log '[部署 4/8] 停止 Web 和 Worker，服务将短暂中断'
    compose stop web worker
    log '[部署 5/8] 创建发布前数据库备份'
    backup
    log '[部署 6/8] 执行数据库迁移'
    compose run --rm --no-deps migrate
    log '[部署 7/8] 启动应用并执行健康检查'
    start_apps
    log "[部署 8/8] 部署完成：$APP_VERSION"
    ;;
  backup) backup ;;
  load) load_release "${2:-$ROOT}" ;;
  restore)
    [[ $# -eq 4 && $4 == --confirm && -f $2 && $3 =~ ^[a-zA-Z0-9._-]+$ ]] || { usage; exit 1; }
    file=$2
    export APP_VERSION=$3
    require_images
    start_db
    compose exec -T db pg_restore --list < "$file" >/dev/null
    CUTOVER=1
    compose stop nginx web worker
    backup
    compose exec -T db dropdb -U postgres --force --if-exists fin_ai_brief
    compose exec -T db createdb -U postgres -O finbrief fin_ai_brief
    compose exec -T db pg_restore -U finbrief -d fin_ai_brief --no-owner --no-acl --exit-on-error --single-transaction < "$file"
    compose run --rm --no-deps migrate
    # A point-in-time restore must not resend mail or resume stale queued automation.
    compose exec -T db psql -U finbrief -d fin_ai_brief -v ON_ERROR_STOP=1 <<'SQL'
UPDATE settings SET value=value || '{"collectionEnabled":false,"deliveryEnabled":false,"dailyEnabled":false,"modelSchedulingEnabled":false}'::jsonb
  || CASE WHEN value ? 'modelConnection' THEN jsonb_build_object('modelConnection',(value->'modelConnection') || '{"enabled":false}'::jsonb) ELSE '{}'::jsonb END WHERE id=1;
SQL
    start_apps
    ;;
  status) compose ps ;;
  logs) compose logs --tail=100 -f "${2:-worker}" ;;
  stop) compose stop nginx web worker ;;
  *) usage; exit 1 ;;
esac
