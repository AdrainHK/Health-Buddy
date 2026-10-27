import { sql } from 'kysely';
import type { Db, TenantTransaction } from './database.js';

/**
 * M5 方案和随访用到的数据库函数（规格 6.1）。原始 SQL 只放在 db 目录里。
 */

/**
 * 清理到期的随访素材原文（Q23）。只能在没有租户上下文的连接上调用（后台任务），
 * 带用户身份时数据库拒绝。只返回删了几份。
 */
export async function visitMaterialsPurgeDue(db: Db, limit: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select visit_materials_purge_due(${limit}) as n
  `.execute(db);
  return rows[0]?.n ?? 0;
}

/**
 * 确认方案、随访计划、随访记录（规格 5.4 第 1 条）：只能经这三个 SECURITY DEFINER 函数写入
 * care_plans、visits、visit_records，函数里重新校验产物属于当前健管师、是最新草稿、kind 正确。
 * 只在已经设置了租户上下文的事务里调用。
 */
export async function approveCarePlan(trx: TenantTransaction, artifactId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select approve_care_plan(${artifactId}::uuid) as id
  `.execute(trx);
  return rows[0]!.id;
}

export async function approveVisitSchedule(
  trx: TenantTransaction,
  artifactId: string,
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select approve_visit_schedule(${artifactId}::uuid) as n
  `.execute(trx);
  return rows[0]?.n ?? 0;
}

export async function approveVisitRecord(
  trx: TenantTransaction,
  artifactId: string,
  followUpItemIds: readonly string[],
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select approve_visit_record(${artifactId}::uuid, ${followUpItemIds}::uuid[]) as id
  `.execute(trx);
  return rows[0]!.id;
}

/** 目标模板关联的监测指标（含已停用的模板；只给健管师） */
export async function planGoalTemplateMetrics(
  trx: TenantTransaction,
  ids: readonly string[],
): Promise<
  {
    id: string;
    params: unknown;
    metric: 'steps' | 'sleep_hours' | null;
    metric_param: string | null;
  }[]
> {
  if (!ids.length) return [];
  const { rows } = await sql<{
    id: string;
    params: unknown;
    metric: 'steps' | 'sleep_hours' | null;
    metric_param: string | null;
  }>`select * from plan_goal_template_metrics(${ids}::uuid[])`.execute(trx);
  return rows;
}

export interface PlanUsageStatsRow {
  operatorId: string;
  date: string;
  plansGenerated: number;
  plansApproved: number;
  schedulesApproved: number;
  visitsDone: number;
  visitsMissed: number;
  recordsApproved: number;
}

/** 方案和随访统计：范围由数据库函数按租户上下文决定（运营商只看本协会） */
export async function planUsageStats(
  trx: TenantTransaction,
  range: { from: string; to: string; operatorId: string | null },
): Promise<PlanUsageStatsRow[]> {
  const { rows } = await sql<{
    operator_id: string;
    day: string;
    plans_generated: number;
    plans_approved: number;
    schedules_approved: number;
    visits_done: number;
    visits_missed: number;
    records_approved: number;
  }>`select * from plan_usage_stats(${range.from}::date, ${range.to}::date, ${range.operatorId}::uuid)`.execute(
    trx,
  );
  return rows.map((r) => ({
    operatorId: r.operator_id,
    date: r.day,
    plansGenerated: r.plans_generated,
    plansApproved: r.plans_approved,
    schedulesApproved: r.schedules_approved,
    visitsDone: r.visits_done,
    visitsMissed: r.visits_missed,
    recordsApproved: r.records_approved,
  }));
}
