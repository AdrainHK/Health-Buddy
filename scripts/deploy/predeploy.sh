#!/bin/sh
# 每次容器启动时由 start.sh 调用：先迁移数据库，预览环境再补齐演示数据。
set -eu

node --enable-source-maps apps/server/dist/db/migrate-cli.js

# 只有显式设置 SEED_ALLOW=yes 的环境（预览）才生成演示数据；已存在就跳过
if [ "${SEED_ALLOW:-}" = "yes" ]; then
  node --enable-source-maps scripts/seed/dist/cli.js --if-missing
  # 合成数据生成后触发一次孪生全量计算（只算还没算过的合成客户，可以重复执行）
  node --enable-source-maps apps/server/dist/twin/compute-cli.js
fi
