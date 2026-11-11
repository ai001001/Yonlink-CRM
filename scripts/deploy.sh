#!/usr/bin/env bash
# 部署已提交的代码到独立发布目录并重启后端服务（不使用 sudo）。
# Deploy the committed code into a separate release directory and restart the backend (no sudo).
#
# 目录 / Layout ($YONLINK_DEPLOY_DIR, 默认 ~/yonlink-deploy):
#   shared/.env      PostgreSQL 连接信息（db.mjs 读取）/ PostgreSQL settings read by db.mjs
#   shared/app.env   后端运行环境变量 / backend runtime env
#   releases/<sha>   每次发布一个目录 / one directory per release
#   current          指向当前发布的符号链接 / symlink to the active release
# 用法 / usage: scripts/deploy.sh [git-ref]   (默认 HEAD / default HEAD)
set -euo pipefail
BASE="${YONLINK_DEPLOY_DIR:-$HOME/yonlink-deploy}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-HEAD}"
SHA="$(git -C "$REPO" rev-parse --short "$REF")"
REL="$BASE/releases/$SHA"

[ -f "$BASE/shared/.env" ] && [ -f "$BASE/shared/app.env" ] || { echo "缺少 $BASE/shared/.env 或 app.env / missing shared env files"; exit 1; }

echo "==> 导出 $SHA 到 $REL / export"
rm -rf "$REL" && mkdir -p "$REL"
git -C "$REPO" archive "$REF" | tar -x -C "$REL"
ln -sfn "$BASE/shared/.env" "$REL/.env"

echo "==> 安装依赖与构建 / install and build"
cd "$REL"
npm ci --no-audit --no-fund
set -a; . "$BASE/shared/app.env"; set +a
npx prisma migrate deploy
npm run build

echo "==> 切换并重启 / switch and restart"
ln -sfn "$REL" "$BASE/current"
# 首次部署时服务尚未安装，可设 YONLINK_SKIP_RESTART=1 跳过 / set YONLINK_SKIP_RESTART=1 on the first deployment
[ "${YONLINK_SKIP_RESTART:-0}" = "1" ] || systemctl --user restart yonlink-crm.service

# 保留最近 3 个发布（不删除当前和正在被数据库服务使用的目录）/ keep the 3 newest releases
ls -1dt "$BASE"/releases/* | tail -n +4 | while read -r old; do
  [ "$(readlink -f "$BASE/current")" = "$old" ] && continue
  fuser -s "$old"/node_modules/@embedded-postgres/*/native/bin/postgres 2>/dev/null && continue
  rm -rf "$old"
done
echo "==> 完成 / done: $SHA"
