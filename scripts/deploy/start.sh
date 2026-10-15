#!/bin/sh
# 容器启动入口：先迁移数据库、按需补齐演示数据，再启动服务。
# 放在启动时而不是 Railway 的 preDeployCommand 里，这样不依赖 Railway 是否读到了 railway.json。
# Dockerfile 的 CMD 和 @health-buddy/server 的 start 脚本都走这里：
# Railway 自动识别单仓库时会把启动命令设成 `pnpm --filter @health-buddy/server start`，两条路径结果一样。
# 迁移和 seed --if-missing 都可以重复执行。
set -eu

# 从任何目录调用都切到仓库根目录
cd "$(dirname "$0")/../.."

# 后台页面（/admin/）：没有显式设置 ADMIN_DIST 时，用仓库里构建好的 apps/admin/dist（存在才用，
# 本地没构建后台时照常启动）。Dockerfile 里也设置了同样的值。
if [ -z "${ADMIN_DIST:-}" ] && [ -f apps/admin/dist/index.html ]; then
  ADMIN_DIST="$(pwd)/apps/admin/dist"
  export ADMIN_DIST
fi

sh scripts/deploy/predeploy.sh
exec node --enable-source-maps apps/server/dist/main.js
