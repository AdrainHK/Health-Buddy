import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  PILOT_PLAN_CODE,
  type CreatePlanRequest,
  type MyPlan,
  type Plan,
  type PlanFeatures,
  type PlanQuotas,
  type UpdatePlanRequest,
} from '@health-buddy/shared';
import { ApiException, badRequest, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import {
  adminAssignPlan,
  adminRetirePlan,
  adminSavePlan,
  adminSetOperatorPlans,
  myPlan,
} from '../db/plans.js';

export const planNotAvailable = () =>
  new ApiException(HttpStatus.BAD_REQUEST, 'plan_not_available');

type PlanRow = {
  id: string;
  code: string;
  name: string;
  features: PlanFeatures;
  monthly_quotas: PlanQuotas;
  status: 'active' | 'retired';
  updated_at: Date;
};

function toPlan(row: PlanRow, assigned: number | null): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    features: row.features,
    monthlyQuotas: row.monthly_quotas,
    status: row.status,
    assignedCount: assigned,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * 套餐（M7 规格 2.5）。读走行级安全；写只调数据库函数（函数里校验角色、写审计）。
 * 别人的对象查不到，返回 undefined → 404。
 */
@Injectable()
export class PlansRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 平台看全部（带使用人数）；协会只看本协会可售的 */
  list(ctx: TenantContext): Promise<Plan[]> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role === 'platform_admin') {
        const rows = (await trx
          .selectFrom('plans')
          .selectAll()
          .orderBy('created_at')
          .execute()) as PlanRow[];
        const counts = await assignedCounts(trx);
        return rows.map((r) => toPlan(r, counts.get(r.id) ?? 0));
      }
      const rows = (await trx
        .selectFrom('plans')
        .innerJoin('operator_plans', 'operator_plans.plan_id', 'plans.id')
        .selectAll('plans')
        .where('operator_plans.operator_id', '=', ctx.operatorId!)
        .where('plans.status', '=', 'active')
        .orderBy('plans.created_at')
        .execute()) as PlanRow[];
      return rows.map((r) => toPlan(r, null));
    });
  }

  create(ctx: TenantContext, v: CreatePlanRequest): Promise<Plan> {
    return this.write(ctx, async (trx) => {
      const id = await adminSavePlan(trx, null, v);
      return (await this.planIn(trx, id!))!;
    });
  }

  update(ctx: TenantContext, id: string, v: UpdatePlanRequest): Promise<Plan | undefined> {
    return this.write(ctx, async (trx) => {
      const saved = await adminSavePlan(trx, id, { ...v, code: '' });
      return saved ? this.planIn(trx, saved) : undefined;
    });
  }

  retire(ctx: TenantContext, id: string): Promise<Plan | undefined> {
    return this.write(ctx, async (trx) =>
      (await adminRetirePlan(trx, id)) ? this.planIn(trx, id) : undefined,
    );
  }

  /** 协会的可售套餐；协会不存在返回 undefined */
  operatorPlans(ctx: TenantContext, operatorId: string): Promise<string[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const op = await trx
        .selectFrom('operators')
        .select('id')
        .where('id', '=', operatorId)
        .executeTakeFirst();
      if (!op) return undefined;
      const rows = await trx
        .selectFrom('operator_plans')
        .select('plan_id')
        .where('operator_id', '=', operatorId)
        .execute();
      return rows.map((r) => r.plan_id);
    });
  }

  setOperatorPlans(
    ctx: TenantContext,
    operatorId: string,
    planIds: string[],
  ): Promise<string[] | undefined> {
    return this.write(ctx, async (trx) => {
      if (!(await adminSetOperatorPlans(trx, operatorId, [...new Set(planIds)]))) return undefined;
      const rows = await trx
        .selectFrom('operator_plans')
        .select('plan_id')
        .where('operator_id', '=', operatorId)
        .execute();
      return rows.map((r) => r.plan_id);
    });
  }

  /** 协会给本协会的健管师分配套餐；账号不是本协会的健管师返回 false → 404 */
  assign(ctx: TenantContext, userId: string, planId: string): Promise<boolean> {
    return this.write(ctx, (trx) => adminAssignPlan(trx, userId, planId));
  }

  myPlan(ctx: TenantContext): Promise<MyPlan | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await myPlan(trx);
      if (!row) return undefined;
      return {
        code: row.code,
        name: row.name,
        features: row.features as PlanFeatures,
        monthlyQuotas: row.monthly_quotas as PlanQuotas,
        contractEnd: row.contract_end ? row.contract_end.toISOString().slice(0, 10) : null,
        usage: {
          llm_calls: Number(row.usage.llm_calls ?? 0),
          expert_calls: Number(row.usage.expert_calls ?? 0),
          report_pages: Number(row.usage.report_pages ?? 0),
          companion_devices: Number(row.companion_devices),
        },
      };
    });
  }

  private async planIn(trx: TenantTransaction, id: string): Promise<Plan | undefined> {
    const row = (await trx
      .selectFrom('plans')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) as PlanRow | undefined;
    if (!row) return undefined;
    return toPlan(row, (await assignedCounts(trx)).get(id) ?? 0);
  }

  /** 代码重复 409；形状不对 400；不可售 400 plan_not_available；对象不存在（P0002）→ 404 */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      const code = dbErrorCode(err);
      if (code === '23505') throw conflict();
      if (code === 'HB003') throw planNotAvailable();
      if (code === '23514' || code === '22023' || code === '22001') throw badRequest();
      if (code === 'P0002') return undefined as T;
      throw err;
    }
  }
}

/** 每个套餐正在用的健管师数（待激活、已激活）；没分配的算在试点版上 */
async function assignedCounts(trx: TenantTransaction): Promise<Map<string, number>> {
  const pilot = await trx
    .selectFrom('plans')
    .select('id')
    .where('code', '=', PILOT_PLAN_CODE)
    .executeTakeFirst();
  const rows = await trx
    .selectFrom('users')
    .leftJoin('user_plans', 'user_plans.user_id', 'users.id')
    .select(['user_plans.plan_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where('users.role', '=', 'manager')
    .where('users.status', 'in', ['pending', 'active'])
    .groupBy('user_plans.plan_id')
    .execute();
  const out = new Map<string, number>();
  for (const r of rows) {
    const id = r.plan_id ?? pilot?.id;
    if (id) out.set(id, (out.get(id) ?? 0) + Number(r.n));
  }
  return out;
}
