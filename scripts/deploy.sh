#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ENV_FILE=${DEPLOY_ENV_FILE:-$ROOT/deploy/.env}
STATE_DIR=${DEPLOY_STATE_DIR:-$ROOT/deploy/.state}
BACKUP_DIR=${DEPLOY_BACKUP_DIR:-$ROOT/deploy/backups}
PROJECT=${DEPLOY_PROJECT:-fin-ai-brief}
mkdir -p "$STATE_DIR" "$BACKUP_DIR"

usage() {
  echo '用法: scripts/deploy.sh init HTTP_PORT TRUSTED_CIDR | deploy | status | logs [service] | backup | load [RELEASE_DIR] | restore FILE VERSION --confirm | stop'
}
if [[ ${1:-} == init ]]; then
  python3 deploy/config.py init "$ENV_FILE" "${2:-}" "${3:-}"
  exit
fi
[[ $# -ge 1 ]] || { usage; exit 1; }
python3 deploy/config.py validate "$ENV_FILE"
command -v docker >/dev/null
release_value() { python3 deploy/config.py release-value "$ROOT" "$1"; }
export APP_VERSION=${APP_VERSION:-$(cat "$STATE_DIR/current" 2>/dev/null || release_value version)}
export POSTGRES_IMAGE=$(cat "$STATE_DIR/postgres-image" 2>/dev/null || release_value postgres_image)
export NGINX_IMAGE=$(cat "$STATE_DIR/nginx-image" 2>/dev/null || release_value nginx_image)
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
  if ! compose exec -T db pg_dump -U finbrief -d fin_ai_brief --format=custom --no-owner --no-acl > "$file.tmp"; then
    rm -f "$file.tmp"
    return 1
  fi
  if ! compose exec -T db pg_restore --list < "$file.tmp" >/dev/null; then
    rm -f "$file.tmp"
    return 1
  fi
  mv "$file.tmp" "$file"
  cp "$ENV_FILE" "$BACKUP_DIR/$stamp.env"
  cat "$STATE_DIR/current" 2>/dev/null > "$BACKUP_DIR/$stamp.version" || echo bootstrap > "$BACKUP_DIR/$stamp.version"
  echo "备份完成: $file"
}
start_apps() {
  compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 web worker
  compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 90 nginx
  printf '%s\n' "$APP_VERSION" > "$STATE_DIR/current.tmp"
  mv "$STATE_DIR/current.tmp" "$STATE_DIR/current"
  printf '%s\n' "$NGINX_IMAGE" > "$STATE_DIR/nginx-image"
  CUTOVER=0
  compose ps
}
require_images() {
  docker image inspect "fin-ai-brief-web:$APP_VERSION" "fin-ai-brief-worker:$APP_VERSION" >/dev/null
}
load_release() {
  local directory=$1 platform expected
  python3 deploy/config.py verify-release "$directory"
  expected=$(python3 deploy/config.py release-value "$directory" platform)
  platform=$(docker info --format '{{.OSType}}/{{.Architecture}}')
  case "$platform" in linux/x86_64) platform=linux/amd64 ;; linux/aarch64) platform=linux/arm64 ;; esac
  [[ $platform == "$expected" ]] || { echo "部署包平台为 ${expected}，服务器平台为 ${platform}，请重新打包" >&2; return 1; }
  docker image load -i "$directory/release/images.tar"
}
start_db() {
  # Database image upgrades are separate maintenance, never an incidental app release.
  compose up -d --no-recreate --pull never --wait --wait-timeout 120 db
  local id
  id=$(compose ps -q db)
  export POSTGRES_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$id")
  printf '%s\n' "$POSTGRES_IMAGE" > "$STATE_DIR/postgres-image"
}

case "$1" in
  deploy)
    load_release "$ROOT"
    export APP_VERSION=$(release_value version)
    export NGINX_IMAGE=$(release_value nginx_image)
    require_images
    echo "部署版本: $APP_VERSION"
    start_db
    CUTOVER=1
    compose stop nginx web worker
    backup
    compose run --rm --no-deps migrate
    start_apps
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
UPDATE settings SET value=value || '{"collectionEnabled":false,"deliveryEnabled":false,"dailyEnabled":false}'::jsonb
  || CASE WHEN value ? 'modelConnection' THEN jsonb_build_object('modelConnection',(value->'modelConnection') || '{"enabled":false}'::jsonb) ELSE '{}'::jsonb END WHERE id=1;
SQL
    start_apps
    ;;
  status) compose ps ;;
  logs) compose logs --tail=100 -f "${2:-worker}" ;;
  stop) compose stop nginx web worker ;;
  *) usage; exit 1 ;;
esac
