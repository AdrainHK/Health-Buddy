import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/**
 * 咨询锁的类别号（两参数 pg_advisory_xact_lock 的第一个参数）。每种锁一个固定常量，
 * 不同用途的锁不会因为 hashtext 撞车而互相等待。
 */
const LOCK_CLASS_EXPERT_QUOTA = 3_001;

/**
 * 同一位健管师的每日专家调用配额（M3 Q12）：事务级咨询锁，事务提交或回滚时自动释放。
 * 两个并发请求都先拿这把锁再数今天的调用次数，不会一起越过上限（租户隔离审查）。
 *
 * 依赖默认的 READ COMMITTED 隔离级别：拿到锁之后的计数查询会看到前一个事务已提交的调用记录。
 * 如果以后把这个事务改成 REPEATABLE READ 或 SERIALIZABLE，快照在锁之前就定了，计数会漏掉并发提交的记录，
 * 那时要改成先拿锁再开事务，或改用行锁。
 */
export async function lockExpertQuota(trx: TenantTransaction, managerId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(${LOCK_CLASS_EXPERT_QUOTA}::int, hashtext(${managerId}))`.execute(
    trx,
  );
}
