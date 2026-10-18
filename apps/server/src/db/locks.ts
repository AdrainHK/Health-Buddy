import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/**
 * 同一位健管师的每日专家调用配额（M3 Q12）：事务级咨询锁，事务提交或回滚时自动释放。
 * 两个并发请求都先拿这把锁再数今天的调用次数，不会一起越过上限（租户隔离审查）。
 */
export async function lockExpertQuota(trx: TenantTransaction, managerId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`expert-quota:${managerId}`}))`.execute(trx);
}
