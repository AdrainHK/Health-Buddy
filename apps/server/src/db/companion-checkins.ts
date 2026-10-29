import type { CheckinKind, CheckinMetric, CheckinSlot, CheckinStatus } from '@health-buddy/shared';
import { sql } from 'kysely';
import type { Db, TenantTransaction } from './database.js';

/**
 * 福宝打卡用到的数据库函数（M6 规格 2.3，迁移 0028）。设备会话（withDevice 事务里）调用；
 * 计划、时间段、窗口、客户都由函数按 app_client_id() 校验，设备角色对计划、打卡、监测、阈值表
 * 没有直接的写权限。companion_checkin_sweep 只在没有租户上下文时调用。原始 SQL 只放在 db 目录里。
 */

export interface DueCheckin {
  planId: string;
  kind: CheckinKind;
  metric: CheckinMetric | null;
  slot: CheckinSlot;
}

/** 今天到期、还没打卡的计划和时间段（按提醒时间） */
export async function dueCheckins(trx: TenantTransaction): Promise<DueCheckin[]> {
  const { rows } = await sql<{
    plan_id: string;
    kind: CheckinKind;
    metric: CheckinMetric | null;
    slot: CheckinSlot;
  }>`select plan_id, kind, metric, slot from companion_due_checkins()`.execute(trx);
  return rows.map((r) => ({ planId: r.plan_id, kind: r.kind, metric: r.metric, slot: r.slot }));
}

export interface TodayCheckin {
  kind: CheckinKind;
  metric: CheckinMetric | null;
  slot: CheckinSlot;
  /** 还没回答时为 null */
  status: CheckinStatus | null;
  values: number[];
}

/** 今天已经到了提醒时间的打卡和结果（给福宝的资料） */
export async function todayCheckins(trx: TenantTransaction): Promise<TodayCheckin[]> {
  const { rows } = await sql<{
    kind: CheckinKind;
    metric: CheckinMetric | null;
    slot: CheckinSlot;
    status: CheckinStatus | null;
    reading_values: (number | string)[];
  }>`select kind, metric, slot, status, reading_values from companion_today_checkins()`.execute(
    trx,
  );
  return rows.map((r) => ({
    kind: r.kind,
    metric: r.metric,
    slot: r.slot,
    status: r.status,
    values: r.reading_values.map(Number),
  }));
}

/** 服药、运动的回答；同一时间段已经打过卡时返回 null */
export async function recordCheckin(
  trx: TenantTransaction,
  planId: string,
  slot: CheckinSlot,
  status: CheckinStatus,
): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`
    select companion_checkin_record(${planId}::uuid, ${slot}, ${status}) as id
  `.execute(trx);
  return rows[0]?.id ?? null;
}

export interface ReadingResult {
  /** 同一时间段已经打过卡时为 null（不再写监测） */
  checkinId: string | null;
  readingIds: string[];
  /** 命中危急阈值的读数（已写“危急指标”预警） */
  criticalReadingId: string | null;
}

/** 测量值（客户已口头确认）：写打卡和监测、标孪生待重算、判断危急阈值 */
export async function recordCheckinReading(
  trx: TenantTransaction,
  planId: string,
  slot: CheckinSlot,
  values: readonly number[],
): Promise<ReadingResult> {
  const { rows } = await sql<{
    checkin_id: string | null;
    reading_ids: string[];
    critical_reading_id: string | null;
  }>`
    select checkin_id, reading_ids, critical_reading_id
    from companion_checkin_reading(${planId}::uuid, ${slot}, ${[...values]}::numeric[])
  `.execute(trx);
  const row = rows[0];
  return {
    checkinId: row?.checkin_id ?? null,
    readingIds: (row?.reading_ids ?? []).map(String),
    criticalReadingId: row?.critical_reading_id ?? null,
  };
}

/** 两次超出合理范围的测量：记一条待确认的测量给健管师 */
export async function addPendingReading(
  trx: TenantTransaction,
  metric: CheckinMetric,
  values: readonly number[],
  text: string,
  messageId: string | null,
): Promise<void> {
  await sql`
    select companion_pending_reading(${metric}, ${[...values]}::numeric[], ${text}, ${messageId}::bigint)
  `.execute(trx);
}

/** 定时任务：窗口已过、没有回答的记“未应答”（N7）；返回新记的条数 */
export async function sweepCheckins(db: Db): Promise<number> {
  const { rows } = await sql<{ n: number }>`select companion_checkin_sweep() as n`.execute(db);
  return Number(rows[0]?.n ?? 0);
}
