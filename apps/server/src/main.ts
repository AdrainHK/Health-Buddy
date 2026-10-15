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
// 启动时检查一次数据库，失败只记录错误码，不退出（健康检查会如实报告）。
try {
  await pingDb(app.get<Db>(DB));
  logger.log('数据库连接正常');
} catch (err) {
  logger.error(`数据库连接失败：${dbErrorCode(err)}`);
}
