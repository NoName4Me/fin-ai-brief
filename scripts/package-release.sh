#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
PLATFORM=linux/amd64
OUTPUT=$ROOT/.data/releases
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM=${2:?Missing platform}; shift 2 ;;
    --output) OUTPUT=${2:?Missing output directory}; shift 2 ;;
    *) echo '用法: scripts/package-release.sh [--platform linux/amd64|linux/arm64] [--output DIR]' >&2; exit 1 ;;
  esac
done
[[ $PLATFORM == linux/amd64 || $PLATFORM == linux/arm64 ]] || { echo '仅支持 linux/amd64 或 linux/arm64' >&2; exit 1; }
VERSION="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
if [[ -n $(git status --porcelain) ]]; then
  VERSION=$VERSION-worktree
fi
mkdir -p "$OUTPUT"
OUTPUT=$(cd "$OUTPUT" && pwd)
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/scripts" "$STAGING/deploy/nginx" "$STAGING/deploy/postgres" "$STAGING/release" "$STAGING/docs"
WEB_IMAGE=fin-ai-brief-web:$VERSION
WORKER_IMAGE=fin-ai-brief-worker:$VERSION
printf '打包版本: %s\n目标平台: %s\n' "$VERSION" "$PLATFORM"
docker buildx build --platform "$PLATFORM" --pull --load --target web -t "$WEB_IMAGE" .
docker buildx build --platform "$PLATFORM" --load --target worker -t "$WORKER_IMAGE" .
# Content-derived names keep infrastructure images distinct from mutable upstream tags.
for image in postgres:17-bookworm nginx:stable-alpine; do
  if ! docker image inspect --platform "$PLATFORM" "$image" >/dev/null 2>&1; then
    docker pull --platform "$PLATFORM" "$image"
  fi
done
PG_ID=$(docker image inspect --platform "$PLATFORM" --format '{{.Id}}' postgres:17-bookworm)
NGINX_ID=$(docker image inspect --platform "$PLATFORM" --format '{{.Id}}' nginx:stable-alpine)
POSTGRES_IMAGE=fin-ai-brief-postgres:17-${PG_ID:7:12}
NGINX_IMAGE=fin-ai-brief-nginx:${NGINX_ID:7:12}
# Buildx preserves the requested architecture when the local daemon is ARM.
printf 'FROM postgres:17-bookworm\n' | docker buildx build --platform "$PLATFORM" --load -t "$POSTGRES_IMAGE" -
printf 'FROM nginx:stable-alpine\n' | docker buildx build --platform "$PLATFORM" --load -t "$NGINX_IMAGE" -
docker image save --platform "$PLATFORM" -o "$STAGING/release/images.tar" "$WEB_IMAGE" "$WORKER_IMAGE" "$POSTGRES_IMAGE" "$NGINX_IMAGE"
cp scripts/deploy.sh "$STAGING/scripts/"
cp deploy/compose.yaml deploy/config.py deploy/.env.example "$STAGING/deploy/"
cp deploy/nginx/default.conf.template "$STAGING/deploy/nginx/"
cp deploy/postgres/10-app-role.sh "$STAGING/deploy/postgres/"
cp docs/deployment.md docs/sources.md "$STAGING/docs/"
python3 - "$STAGING" "$VERSION" "$PLATFORM" "$POSTGRES_IMAGE" "$NGINX_IMAGE" <<'PY'
import hashlib, json, sys
from pathlib import Path
root=Path(sys.argv[1])
def digest(path):
    with path.open('rb') as f:
        h=hashlib.sha256()
        for chunk in iter(lambda:f.read(1024*1024),b''):
            h.update(chunk)
        return h.hexdigest()
manifest={'version':sys.argv[2],'platform':sys.argv[3],'postgres_image':sys.argv[4],'nginx_image':sys.argv[5],
          'files':{str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file()}}
(root/'release/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
FILE="$OUTPUT/fin-ai-brief-$VERSION-${PLATFORM#linux/}.tar.gz"
# COPYFILE_DISABLE prevents macOS resource-fork files from entering the Linux bundle.
COPYFILE_DISABLE=1 tar -czf "$FILE.tmp" -C "$STAGING" .
mv "$FILE.tmp" "$FILE"
printf '部署包: %s\n' "$FILE"
