import { loadConfig } from '../config.js';
import { createDb } from '../db/database.js';
import { computePendingTwins } from './compute-pending.js';

/**
 * 合成数据生成后触发一次孪生全量计算：pnpm seed 和预览环境的启动脚本在 seed 之后调用。
 * 只算还没算过的合成客户，可以重复执行。只打印数量，不打印任何客户信息。
 */
const config = loadConfig();
const db = createDb(config.appDatabaseUrl, 2);
try {
  const { computed, skipped } = await computePendingTwins(db, { syntheticOnly: true });
  console.log(`孪生计算完成：${computed} 位客户，跳过 ${skipped} 位`);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? ` (${String(err.code)})` : '';
  console.error(`孪生计算失败：${err instanceof Error ? err.name : 'unknown'}${code}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
