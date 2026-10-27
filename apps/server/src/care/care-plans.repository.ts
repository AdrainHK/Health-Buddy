import { Inject, Injectable } from '@nestjs/common';
import {
  adherence,
  type AdherenceResponse,
  type CarePlan,
  type CarePlanCycleWeeks,
  type CarePlanListResponse,
  type CarePlanSnapshot,
  type CarePlanSummary,
  type GoalParam,
  type PlanSection,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { localDate } from '../twin/time-zone.js';
import { clientVisible } from '../twin/twin.repository.js';
import { dateText, iso, managerTimeZone } from './common.js';

/**
 * 方案（M5 规格 2.6、6.4）：只有服务这位客户的健管师能看（行级安全，Q28）。
 * 方案只经确认函数生效（3b），这里只读、结束和执行情况。方案文字和目标参数不进日志。
 */

/** 执行情况读多少天的监测（窗口最长 14 天，多读一天容纳时区差别） */
const ADHERENCE_LOOKBACK_DAYS = 15;

export type EndPlanResult = CarePlanSummary | 'not_found' | 'not_active';

@Injectable()
export class CarePlansRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 客户的当前方案和历史方案；客户不是自己的返回 undefined（404） */
  list(ctx: TenantContext, clientId: string): Promise<CarePlanListResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const rows = await selectPlans(trx)
        .where('client_id', '=', clientId)
        .orderBy('approved_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const plans = rows.map(toSummary);
      return {
        current: plans.find((p) => p.status === 'active') ?? null,
        history: plans.filter((p) => p.status !== 'active'),
      };
    });
  }

  /** 方案快照全文；别人的方案、客户已转出后原健管师查不到（行级安全） */
  get(ctx: TenantContext, id: string): Promise<CarePlan | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await selectPlans(trx).select('snapshot').where('id', '=', id).executeTakeFirst();
      return row && { ...toSummary(row), snapshot: row.snapshot as CarePlanSnapshot };
    });
  }

  /** 结束生效方案（原因必填）。结束人和时间由触发器填写 */
  end(
    ctx: TenantContext,
    id: string,
    reason: CarePlanSummary['endReason'],
  ): Promise<EndPlanResult> {
    return withTenant(this.db, ctx, async (trx) => {
      const current = await trx
        .selectFrom('care_plans')
        .select(['id', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found';
      if (current.status !== 'active') return 'not_active';
      await trx
        .updateTable('care_plans')
        .set({ status: 'ended', end_reason: reason })
        .where('id', '=', id)
        .execute();
      const row = await selectPlans(trx).where('id', '=', id).executeTakeFirstOrThrow();
      return toSummary(row);
    });
  }

  /**
   * 当前方案的执行情况（2.6、Q10）：对照关联了监测指标的目标算近 7、14 天。确定性计算，
   * 只显示，不生成跟进项、不改孪生状态。没有生效方案返回 null；客户不是自己的返回 undefined。
   * 目标模板以后被停用（健管师看不到）时按“需在随访时了解”处理。
   */
  adherence(
    ctx: TenantContext,
    clientId: string,
    tzFallback?: string,
  ): Promise<AdherenceResponse | null | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const plan = await trx
        .selectFrom('care_plans')
        .select(['id', 'snapshot'])
        .where('client_id', '=', clientId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!plan) return null;
      const tz = await managerTimeZone(trx, ctx, tzFallback);
      const goals = (plan.snapshot as CarePlanSnapshot).structured.sections.flatMap((s) => s.goals);
      const templateIds = [...new Set(goals.map((g) => g.templateId))];
      const templates = templateIds.length
        ? await trx
            .selectFrom('plan_goal_templates')
            .select(['id', 'params', 'metric', 'metric_param'])
            .where('id', 'in', templateIds)
            .execute()
        : [];
      const byId = new Map(templates.map((t) => [t.id, t]));
      const tracked: { key: string; metric: 'steps' | 'sleep_hours'; target: number }[] = [];
      const untracked = new Set<string>();
      for (const g of goals) {
        const t = byId.get(g.templateId);
        const target = t?.metric_param ? g.params[t.metric_param] : undefined;
        const param = (t?.params as GoalParam[] | undefined)?.find(
          (p) => p.name === t?.metric_param,
        );
        if (t?.metric && typeof target === 'number' && param?.type === 'int') {
          tracked.push({ key: g.templateId, metric: t.metric, target });
        } else {
          untracked.add(g.templateId);
        }
      }
      const now = new Date();
      const readings = tracked.length
        ? await trx
            .selectFrom('monitoring_readings')
            .select(['metric', 'value', 'measured_at'])
            .where('client_id', '=', clientId)
            .where('metric', 'in', [...new Set(tracked.map((g) => g.metric))])
            .where(
              'measured_at',
              '>=',
              new Date(now.getTime() - ADHERENCE_LOOKBACK_DAYS * 86_400_000),
            )
            .execute()
        : [];
      const results = adherence({
        now,
        timeZone: tz,
        goals: tracked,
        readings: readings.map((r) => ({
          metric: r.metric,
          value: Number(r.value),
          measuredAt: r.measured_at,
        })),
      });
      return {
        planId: plan.id,
        asOf: localDate(now, tz),
        timeZone: tz,
        goals: results.map((r) => ({
          templateId: r.key,
          metric: r.metric,
          target: r.target,
          hasData: r.hasData,
          windows: r.windows,
        })),
        untrackedTemplateIds: [...untracked],
      };
    });
  }
}

function selectPlans(trx: TenantTransaction) {
  return trx
    .selectFrom('care_plans')
    .select((eb) => [
      'id',
      'client_id',
      'artifact_id',
      'sections',
      'cycle_weeks',
      'status',
      'end_reason',
      'approved_at',
      'ended_at',
      dateText(eb, 'start_date').as('start_date_text'),
      dateText(eb, 'review_date').as('review_date_text'),
    ]);
}

function toSummary(r: {
  id: string;
  client_id: string;
  artifact_id: string | null;
  sections: string[];
  cycle_weeks: number;
  status: CarePlanSummary['status'];
  end_reason: CarePlanSummary['endReason'];
  approved_at: Date;
  ended_at: Date | null;
  start_date_text: string;
  review_date_text: string;
}): CarePlanSummary {
  return {
    id: r.id,
    clientId: r.client_id,
    artifactId: r.artifact_id,
    sections: r.sections as PlanSection[],
    cycleWeeks: r.cycle_weeks as CarePlanCycleWeeks,
    startDate: r.start_date_text,
    reviewDate: r.review_date_text,
    status: r.status,
    endReason: r.end_reason,
    approvedAt: r.approved_at.toISOString(),
    endedAt: iso(r.ended_at),
  };
}
