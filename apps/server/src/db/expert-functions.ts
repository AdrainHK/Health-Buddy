import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/** expert_usage_stats 返回的一行：只有协会、专家、日期和汇总数字（迁移 0014） */
export interface ExpertUsageStatsRow {
  operatorId: string;
  expertId: string;
  date: string;
  calls: number;
  succeeded: number;
  timedOut: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  useful: number;
  notUseful: number;
}

/**
 * 专家调用统计（M3 规格 6.2）。必须在 withTenant 里调用：范围由数据库函数按租户上下文决定，
 * 运营商只能看本协会（operatorId 被忽略），平台管理员看全部或按协会筛选，其他角色数据库直接拒绝。
 */
export async function expertUsageStats(
  trx: TenantTransaction,
  range: { from: string; to: string; operatorId: string | null },
): Promise<ExpertUsageStatsRow[]> {
  const { rows } = await sql<{
    operator_id: string;
    expert_id: string;
    day: string;
    calls: number;
    succeeded: number;
    timed_out: number;
    input_tokens: string;
    output_tokens: string;
    cost_usd: string;
    useful: number;
    not_useful: number;
  }>`select * from expert_usage_stats(${range.from}::date, ${range.to}::date, ${range.operatorId}::uuid)`.execute(
    trx,
  );
  return rows.map((r) => ({
    operatorId: r.operator_id,
    expertId: r.expert_id,
    date: r.day,
    calls: r.calls,
    succeeded: r.succeeded,
    timedOut: r.timed_out,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd),
    useful: r.useful,
    notUseful: r.not_useful,
  }));
}
