import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/** 运营看板的数据库函数（迁移 0036）：范围由会话决定，只有汇总数字 */
export interface OpsDashboardRaw {
  groups: (Record<string, number | string | null> & {
    operator_id: string;
    org_id: string | null;
  })[];
  skills: { operator_id: string; skill_id: string; n: number }[];
  twin_opens: { operator_id: string; n: number }[];
}

export async function opsDashboard(
  trx: TenantTransaction,
  from: string,
  to: string,
  operatorId: string | null,
): Promise<OpsDashboardRaw> {
  const { rows } = await sql<{ r: OpsDashboardRaw }>`
    select ops_dashboard(${from}::date, ${to}::date, ${operatorId}::uuid) as r
  `.execute(trx);
  return rows[0]!.r;
}
