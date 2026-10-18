import { sql } from 'kysely';
import type { Db, TenantContext, TenantTransaction } from './database.js';

/**
 * 孪生计算和统计用到的数据库函数（M4 规格 3.2、7.2，迁移 0017）。原始 SQL 只放在 db 目录里。
 * twin_compute_context、twin_request_all、twin_pending_clients 只能在没有租户上下文的连接上调用
 * （后台任务），只返回身份或客户 id，不返回任何健康数据。
 */

/** 队列任务的执行身份：客户当前的健管师（在职、协会正常）。查不到时为空 */
export async function twinComputeContext(
  db: Db,
  clientId: string,
): Promise<TenantContext | undefined> {
  const { rows } = await sql<{
    user_id: string;
    role: TenantContext['role'];
    operator_id: string | null;
    org_id: string | null;
  }>`select * from twin_compute_context(${clientId}::uuid)`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  return { userId: row.user_id, role: row.role, operatorId: row.operator_id, orgId: row.org_id };
}

/** 规则或危急阈值修改后：所有客户标为“正在更新”，返回客户 id */
export async function twinRequestAll(db: Db): Promise<string[]> {
  const { rows } = await sql<{ twin_request_all: string }>`select twin_request_all()`.execute(db);
  return rows.map((r) => r.twin_request_all);
}

/** 还没有算过的客户（合成数据生成后的全量计算） */
export async function twinPendingClients(db: Db, syntheticOnly: boolean): Promise<string[]> {
  const { rows } = await sql<{
    twin_pending_clients: string;
  }>`select twin_pending_clients(${syntheticOnly})`.execute(db);
  return rows.map((r) => r.twin_pending_clients);
}

/** 孪生打开次数加一（只记协会和日期）。在健管师或机构管理员的租户事务里调用 */
export async function twinRecordOpen(trx: TenantTransaction): Promise<void> {
  await sql`select twin_record_open()`.execute(trx);
}

/** 恢复默认规则：由 twin_status_rules_reset 以所有者身份写入，修改记录标为 reset（迁移 0016） */
export async function twinStatusRulesReset(
  trx: TenantTransaction,
  rules: readonly Record<string, unknown>[],
): Promise<void> {
  await sql`select twin_status_rules_reset(${JSON.stringify(rules)}::jsonb)`.execute(trx);
}

/** 改自己的时区（null 为不设置）。时区名不存在时数据库拒绝（22023） */
export async function userSetTimezone(trx: TenantTransaction, tz: string | null): Promise<void> {
  await sql`select user_set_timezone(${tz}::text)`.execute(trx);
}

/** twin_usage_stats 的一行：只有协会、日期和汇总数字 */
export interface TwinUsageStatsRow {
  operatorId: string;
  date: string;
  opens: number;
  followUpsCreated: number;
  done: number;
  snoozed: number;
  dismissed: number;
  reopened: number;
  summaries: number;
}

/**
 * 孪生统计。必须在 withTenant 里调用：范围由数据库函数按租户上下文决定，
 * 运营商只能看本协会（operatorId 被忽略），平台管理员看全部或按协会筛选，其他角色数据库直接拒绝。
 */
export async function twinUsageStats(
  trx: TenantTransaction,
  range: { from: string; to: string; operatorId: string | null },
): Promise<TwinUsageStatsRow[]> {
  const { rows } = await sql<{
    operator_id: string;
    day: string;
    opens: number;
    follow_ups_created: number;
    done: number;
    snoozed: number;
    dismissed: number;
    reopened: number;
    summaries: number;
  }>`select * from twin_usage_stats(${range.from}::date, ${range.to}::date, ${range.operatorId}::uuid)`.execute(
    trx,
  );
  return rows.map((r) => ({
    operatorId: r.operator_id,
    date: r.day,
    opens: r.opens,
    followUpsCreated: r.follow_ups_created,
    done: r.done,
    snoozed: r.snoozed,
    dismissed: r.dismissed,
    reopened: r.reopened,
    summaries: r.summaries,
  }));
}

/** 数据库当前时间（计算开始的时刻），用 clock_timestamp 而不是事务开始时间 */
export async function dbClock(trx: TenantTransaction): Promise<Date> {
  const { rows } = await sql<{ t: Date }>`select clock_timestamp() as t`.execute(trx);
  return rows[0]!.t;
}
