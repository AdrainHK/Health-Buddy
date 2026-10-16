import { sql, type RawBuilder } from 'kysely';
import type { Db, TenantContext } from './database.js';

/**
 * 报告上传用到的数据库函数和日期表达式（M2 规格 3.2）。原始 SQL 只放在 db 目录里。
 * 下面几个函数是 SECURITY DEFINER，只返回身份或存储 key，不返回业务数据。
 */

/** 队列任务的发起人：只对排队中、识别中的记录、仍在职的用户有结果 */
export async function reportUploadRequester(
  db: Db,
  uploadId: string,
): Promise<TenantContext | undefined> {
  const { rows } = await sql<{
    user_id: string;
    role: TenantContext['role'];
    operator_id: string | null;
    org_id: string | null;
  }>`select * from report_upload_requester(${uploadId})`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  return { userId: row.user_id, role: row.role, operatorId: row.operator_id, orgId: row.org_id };
}

/** 客户删除后待清除的原件 key */
export async function storagePurgeBatch(db: Db, limit: number): Promise<string[]> {
  const { rows } = await sql<{
    storage_purge_batch: string;
  }>`select storage_purge_batch(${limit})`.execute(db);
  return rows.map((r) => r.storage_purge_batch);
}

export async function storagePurgeDone(db: Db, keys: string[]): Promise<void> {
  if (keys.length) await sql`select storage_purge_done(${keys}::text[])`.execute(db);
}

/** YYYY-MM-DD 按日期比较，不经过 JS Date，避免时区把日期挪一天 */
export function asDate(text: string): RawBuilder<Date> {
  return sql<Date>`${text}::date`;
}

/** 数据库的当天（识别页数按数据库日期计） */
export function currentDate(): RawBuilder<Date> {
  return sql<Date>`current_date`;
}
