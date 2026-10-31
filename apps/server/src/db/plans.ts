import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/** M7 套餐和额度的数据库函数（迁移 0035）。函数开头校验调用者角色、写审计；这里只负责传参 */

export async function adminSavePlan(
  trx: TenantTransaction,
  id: string | null,
  v: { code: string; name: string; features: unknown; monthlyQuotas: unknown },
): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`
    select admin_save_plan(${id}::uuid, ${v.code}, ${v.name}, ${JSON.stringify(v.features)}::jsonb,
      ${JSON.stringify(v.monthlyQuotas)}::jsonb) as id
  `.execute(trx);
  return rows[0]?.id ?? null;
}

export async function adminRetirePlan(trx: TenantTransaction, id: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`select admin_retire_plan(${id}::uuid) as ok`.execute(
    trx,
  );
  return rows[0]?.ok === true;
}

export async function adminSetOperatorPlans(
  trx: TenantTransaction,
  operatorId: string,
  planIds: string[],
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_set_operator_plans(${operatorId}::uuid, ${planIds}::uuid[]) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

export async function adminAssignPlan(
  trx: TenantTransaction,
  userId: string,
  planId: string,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_assign_plan(${userId}::uuid, ${planId}::uuid) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

export type MeteredQuota = 'llm_calls' | 'expert_calls' | 'report_pages';

/** 记一次用量；超过本月额度返回 false（不记数）。bypass：危机、急症照常记数、不拦截 */
export async function quotaConsume(
  trx: TenantTransaction,
  metric: MeteredQuota,
  n: number,
  bypass: boolean,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select quota_consume(${metric}, ${n}, ${bypass}) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

/** 再绑一台伴侣设备是否超过套餐的设备数上限 */
export async function quotaCompanionDeviceOk(trx: TenantTransaction): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`select quota_companion_device_ok() as ok`.execute(
    trx,
  );
  return rows[0]?.ok === true;
}

export async function planFeatureEnabled(
  trx: TenantTransaction,
  feature: string,
): Promise<boolean> {
  const { rows } = await sql<{
    ok: boolean;
  }>`select plan_feature_enabled(${feature}) as ok`.execute(trx);
  return rows[0]?.ok === true;
}

export interface MyPlanRow {
  code: string;
  name: string;
  features: Record<string, boolean>;
  monthly_quotas: Record<string, number | null>;
  contract_end: Date | null;
  usage: Record<string, number>;
  companion_devices: string;
}

export async function myPlan(trx: TenantTransaction): Promise<MyPlanRow | undefined> {
  const { rows } = await sql<MyPlanRow>`select * from my_plan()`.execute(trx);
  return rows[0];
}
