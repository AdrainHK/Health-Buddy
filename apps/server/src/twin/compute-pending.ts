import type { Db } from '../db/database.js';
import { twinPendingClients } from '../db/twin-functions.js';
import { TwinEngine } from './twin-engine.js';
import { TwinJobRejected } from './twin-queue.js';

/**
 * 合成数据生成后的全量计算（M4 规格 3.2 最后一条）：把还没算过的客户逐个算一遍，触发原因记为 seed。
 * 用应用角色连接（受行级安全约束），每位客户在他的健管师上下文里计算，和队列任务走同一套代码。
 * 默认只算合成客户。返回算了几位、跳过几位（健管师不在职等）。
 */
export async function computePendingTwins(
  db: Db,
  options: { syntheticOnly: boolean } = { syntheticOnly: true },
): Promise<{ computed: number; skipped: number }> {
  const engine = new TwinEngine(db);
  let computed = 0;
  let skipped = 0;
  for (const clientId of await twinPendingClients(db, options.syntheticOnly)) {
    try {
      await engine.compute(clientId, 'seed');
      computed++;
    } catch (err) {
      if (!(err instanceof TwinJobRejected)) throw err;
      skipped++;
    }
  }
  return { computed, skipped };
}
