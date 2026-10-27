import type { ExpressionBuilder } from 'kysely';
import type { TenantContext, TenantTransaction } from '../db/database.js';

/**
 * 方案和随访共用的小工具（M5 第 3 步）。
 */

/** 健管师的时区：账号设置的优先，其次浏览器时区，都没有时用 UTC（同 M4 今日跟进，Q13） */
export async function managerTimeZone(
  trx: TenantTransaction,
  ctx: TenantContext,
  fallback?: string,
): Promise<string> {
  const row = await trx
    .selectFrom('users')
    .select('timezone')
    .where('id', '=', ctx.userId)
    .executeTakeFirst();
  return row?.timezone ?? fallback ?? 'UTC';
}

/** date 列用文本取出（YYYY-MM-DD）：不经过 JS Date，避免时区把日期挪一天 */
export function dateText<C extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 多张表共用，只用到这一列
  eb: ExpressionBuilder<any, any>,
  column: C,
) {
  return eb.fn<string>('to_char', [eb.ref(column), eb.val('YYYY-MM-DD')]);
}

export function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
