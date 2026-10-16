import { Logger } from '@nestjs/common';
import { createApp } from './app.js';
import { dbErrorCode } from './common/db-error.js';
import { loadConfig } from './config.js';
import { DB } from './db/db.provider.js';
import { pingDb, type Db } from './db/database.js';

const config = loadConfig();
const app = await createApp(config);
app.enableShutdownHooks();
await app.listen(config.port, '0.0.0.0');
const logger = new Logger('Bootstrap');
logger.log(`Health Buddy server listening on port ${config.port}`);
// 报告识别依赖对象存储和 Redis；没配置时只提示变量名，不打印值
if (config.incompleteStorageVars.length) {
  logger.warn(`对象存储变量不完整，报告上传未启用：缺少 ${config.incompleteStorageVars.join('、')}`);
}
if (!config.storage || !config.redisUrl) {
  logger.warn('报告上传和识别未启用：需要配置 S3_* 和 REDIS_URL');
}
// 启动时检查一次数据库，失败只记录错误码，不退出（健康检查会如实报告）。
try {
  await pingDb(app.get<Db>(DB));
  logger.log('数据库连接正常');
} catch (err) {
  logger.error(`数据库连接失败：${dbErrorCode(err)}`);
}
