#!/bin/sh
# Railway 每次部署前运行：先迁移数据库，预览环境再补齐演示数据。
set -eu

node --enable-source-maps apps/server/dist/db/migrate-cli.js

# 只有显式设置 SEED_ALLOW=yes 的环境（预览）才生成演示数据；已存在就跳过
if [ "${SEED_ALLOW:-}" = "yes" ]; then
  node --enable-source-maps scripts/seed/dist/cli.js --if-missing
fi
