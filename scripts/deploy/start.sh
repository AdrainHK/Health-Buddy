#!/bin/sh
# 容器启动入口：先迁移数据库、按需补齐演示数据，再启动服务。
# 放在启动时而不是 Railway 的 preDeployCommand 里，这样不依赖 Railway 是否读到了 railway.json。
# 迁移和 seed --if-missing 都可以重复执行。
set -eu

sh scripts/deploy/predeploy.sh
exec node --enable-source-maps apps/server/dist/main.js
