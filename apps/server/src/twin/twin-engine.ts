import { Logger } from '@nestjs/common';
import {
  type AbnormalFlag,
  type CriticalComparator,
  type ForecastResult,
  type IndicatorCode,
  type TwinComputeTrigger,
  type TwinDomain,
  type TwinLevel,
  type TwinStatusRule,
} from '@health-buddy/shared';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { lockTwinCompute } from '../db/locks.js';
import { dbClock, twinComputeContext } from '../db/twin-functions.js';
import { TwinJobRejected } from './twin-queue.js';
import { planTwinUpdate, type PlanInput, type TwinPlan } from './twin-plan.js';

/** 报告指标读多少行、监测读多少天：预测要 24 个月报告和 26 周监测，状态最多 90 天窗口 */
const REPORT_ROW_LIMIT = 5000;
const READING_DAYS = 200;
const READING_ROW_LIMIT = 20000;
const DAY_MS = 86_400_000;
/** 并发的计算写入冲突时最多重算几次 */
const MAX_ATTEMPTS = 3;

export type TwinComputeOutcome = 'done' | 'discarded';

export interface TwinComputeSummary {
  outcome: TwinComputeOutcome;
  statusRows: number;
  forecasts: number;
  followUps: number;
}

/**
 * 孪生计算（M4 规格 3.2）。不依赖 Nest，后台任务和合成数据脚本共用。
 *
 * 1. 按 client_id 从数据库找出客户当前的健管师（twin_compute_context），找不到就拒绝，不读任何数据；
 * 2. 以他的租户上下文（withTenant）读数据，在内存里算出要写的内容（planTwinUpdate）；
 * 3. 另开一个事务写入：先拿这位客户的计算锁，再重新确认客户仍归这位健管师（不是就丢弃结果），
 *    确认读数据之后没有别的计算写过（写过就重算），然后写状态历史、预测和跟进项。
 * 读和写分开两个事务，计算期间不占客户行的锁，客户转出不会被计算挡住。
 */
export class TwinEngine {
  private readonly logger = new Logger('TwinCompute');

  constructor(private readonly db: Db) {}

  async compute(clientId: string, trigger: TwinComputeTrigger): Promise<TwinComputeSummary> {
    const started = Date.now();
    const ctx = await twinComputeContext(this.db, clientId);
    if (!ctx) throw new TwinJobRejected();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const loaded = await withTenant(this.db, ctx, (trx) =>
        this.load(trx, ctx, clientId, trigger),
      );
      if (!loaded) throw new TwinJobRejected();
      const plan = await this.plan(loaded.input);
      const result = await withTenant(this.db, ctx, (trx) =>
        this.write(trx, ctx, clientId, trigger, loaded, plan),
      );
      if (result === 'retry') continue;
      this.logger.log(
        `twin compute ${JSON.stringify({
          clientId,
          trigger,
          outcome: result.outcome,
          statusRows: result.statusRows,
          forecasts: result.forecasts,
          followUps: result.followUps,
          durationMs: Date.now() - started,
        })}`,
      );
      return result;
    }
    throw new Error('twin compute kept conflicting');
  }

  /** 算出要写入的内容（纯函数）。单独成方法，测试里可以在读和写之间插入操作 */
  plan(input: PlanInput): Promise<TwinPlan> {
    return Promise.resolve(planTwinUpdate(input));
  }

  /** 读计算需要的数据。客户不归这位健管师时返回 undefined */
  private async load(
    trx: TenantTransaction,
    ctx: TenantContext,
    clientId: string,
    trigger: TwinComputeTrigger,
  ): Promise<{ input: PlanInput; computedAt: Date | null; loadAt: Date } | undefined> {
    const client = await trx
      .selectFrom('clients')
      .select('id')
      .where('id', '=', clientId)
      .where('manager_id', '=', ctx.userId)
      .executeTakeFirst();
    if (!client) return undefined;
    const loadAt = await dbClock(trx);

    const state = await trx
      .selectFrom('twin_compute_state')
      .select('computed_at')
      .where('client_id', '=', clientId)
      .executeTakeFirst();

    const ruleRows = await trx.selectFrom('twin_status_rules').selectAll().execute();
    const version = await trx.selectFrom('twin_rules_version').select('version').executeTakeFirst();
    const thresholds = await trx
      .selectFrom('critical_thresholds')
      .select(['metric', 'comparator', 'value', 'level', 'enabled'])
      .execute();

    const reportRows = await trx
      .selectFrom('report_indicators as i')
      .innerJoin('health_reports as r', (join) =>
        join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
      )
      .select((eb) => [
        'i.id',
        'i.report_id',
        'i.code',
        'i.value',
        'i.unit',
        'i.ref_low',
        'i.ref_high',
        'i.abnormal',
        'i.superseded_by',
        'i.created_at',
        eb.fn<string>('to_char', [eb.ref('r.report_date'), eb.val('YYYY-MM-DD')]).as('report_date'),
      ])
      .where('i.client_id', '=', clientId)
      .where('i.code', 'is not', null)
      .where('i.value', 'is not', null)
      .orderBy('r.report_date', 'desc')
      .orderBy('i.created_at', 'desc')
      .limit(REPORT_ROW_LIMIT)
      .execute();

    const readingRows = await trx
      .selectFrom('monitoring_readings')
      .select(['id', 'metric', 'value', 'unit', 'measured_at', 'created_at'])
      .where('client_id', '=', clientId)
      .where('measured_at', '>=', new Date(loadAt.getTime() - READING_DAYS * DAY_MS))
      .orderBy('measured_at', 'desc')
      .limit(READING_ROW_LIMIT)
      .execute();

    const lastRows = await trx
      .selectFrom('twin_status_history')
      .distinctOn('domain')
      .select(['domain', 'level', 'basis'])
      .where('client_id', '=', clientId)
      .where('origin', '=', 'computed')
      .orderBy('domain')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    const forecastRows = await trx
      .selectFrom('twin_forecasts')
      .selectAll()
      .where('client_id', '=', clientId)
      .where('superseded_at', 'is', null)
      .execute();

    const criticalRefs = await trx
      .selectFrom('follow_up_items')
      .select(sql<string | null>`source_ref ->> 'dataRef'`.as('data_ref'))
      .where('client_id', '=', clientId)
      .where('kind', '=', 'critical')
      .execute();

    const rules: TwinStatusRule[] = ruleRows.map((r) => ({
      id: r.id,
      domain: r.domain,
      metric: r.metric as IndicatorCode,
      source: r.source,
      method: r.method,
      comparator: r.comparator,
      value: r.value === null ? null : Number(r.value),
      unit: r.unit,
      windowDays: r.window_days,
      level: r.level,
      enabled: r.enabled,
    }));

    const input: PlanInput = {
      now: loadAt.toISOString(),
      trigger,
      rules,
      rulesVersion: version?.version ?? 0,
      criticalRules: thresholds.map((t) => ({
        metric: t.metric as IndicatorCode,
        comparator: t.comparator as CriticalComparator,
        value: Number(t.value),
        level: t.level,
        enabled: t.enabled,
      })),
      reportValues: reportRows
        .filter((r) => r.code !== null && r.value !== null)
        .map((r) => ({
          indicatorId: r.id,
          reportId: r.report_id,
          metric: r.code!,
          value: Number(r.value),
          unit: r.unit,
          reportDate: r.report_date,
          refLow: r.ref_low === null ? null : Number(r.ref_low),
          refHigh: r.ref_high === null ? null : Number(r.ref_high),
          abnormal: r.abnormal as AbnormalFlag,
          supersededBy: r.superseded_by,
          createdAt: r.created_at.toISOString(),
        }))
        // 同一指标按报告日期升序：同一天的多条取靠后的一条（evaluateDomainStatus 的约定）
        .reverse(),
      readings: readingRows
        .map((r) => ({
          id: String(r.id),
          metric: r.metric,
          value: Number(r.value),
          unit: r.unit,
          measuredAt: r.measured_at.toISOString(),
          createdAt: r.created_at.toISOString(),
        }))
        .reverse(),
      lastComputed: new Map(
        lastRows.map((r) => [
          r.domain as TwinDomain,
          { level: r.level as TwinLevel, basis: r.basis },
        ]),
      ),
      currentForecasts: forecastRows.map((f) => ({
        id: f.id,
        computedAt: f.computed_at.toISOString(),
        result: forecastFromRow(f),
      })),
      handledDataRefs: new Set(
        criticalRefs.map((r) => r.data_ref).filter((r): r is string => typeof r === 'string'),
      ),
    };
    return { input, computedAt: state?.computed_at ?? null, loadAt };
  }

  private async write(
    trx: TenantTransaction,
    ctx: TenantContext,
    clientId: string,
    trigger: TwinComputeTrigger,
    loaded: { computedAt: Date | null; loadAt: Date },
    plan: TwinPlan,
  ): Promise<TwinComputeSummary | 'retry'> {
    await lockTwinCompute(trx, clientId);
    // 写库前重新确认客户仍归这位健管师；锁住客户行，写完之前不能被转出
    const still = await trx
      .selectFrom('clients')
      .select('id')
      .where('id', '=', clientId)
      .where('manager_id', '=', ctx.userId)
      .forShare()
      .executeTakeFirst();
    if (!still) return { outcome: 'discarded', statusRows: 0, forecasts: 0, followUps: 0 };

    const state = await trx
      .selectFrom('twin_compute_state')
      .select('computed_at')
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    const stateAt = state?.computed_at?.getTime() ?? null;
    if (stateAt !== (loaded.computedAt?.getTime() ?? null)) return 'retry';

    const scope = {
      operator_id: ctx.operatorId ?? '',
      org_id: ctx.orgId,
      manager_id: ctx.userId,
      client_id: clientId,
    };

    const historyIds = new Map<TwinDomain, string>();
    let statusRows = 0;
    for (const s of plan.statuses) {
      if (!s.insert) continue;
      const row = await trx
        .insertInto('twin_status_history')
        .values({
          ...scope,
          domain: s.domain,
          level: s.level,
          origin: 'computed',
          basis: JSON.stringify(s.basis),
          rules_version: plan.rulesVersion,
          trigger,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      historyIds.set(s.domain, row.id);
      statusRows++;
    }

    for (const f of plan.forecasts) {
      if (f.supersedeId) {
        await trx
          .updateTable('twin_forecasts')
          .set({ superseded_at: new Date() })
          .where('id', '=', f.supersedeId)
          .where('superseded_at', 'is', null)
          .execute();
      }
      const r = f.result;
      await trx
        .insertInto('twin_forecasts')
        .values({
          ...scope,
          metric: f.metric,
          source: f.source,
          method_version: r.methodVersion,
          horizon_months: r.horizonMonths,
          points: JSON.stringify(r.points),
          basis: r.basis ? JSON.stringify(r.basis) : null,
          fit: r.fit ? JSON.stringify(r.fit) : null,
          interval_level: r.intervalLevel,
          n_points: r.nPoints,
          span_days: r.spanDays,
          uncertainty: r.uncertainty,
          status: r.status,
          insufficient_reason: r.insufficientReason,
          points_needed: r.pointsNeeded,
        })
        .execute();
    }

    for (const item of plan.followUps) {
      const sourceRef =
        item.domain && (item.kind === 'status_red' || item.kind === 'status_worsened')
          ? { ...item.sourceRef, twinStatusHistoryId: historyIds.get(item.domain) ?? null }
          : item.sourceRef;
      // 同一客户、同一类型、同一指标（或方面）已有未处理的项目时只更新最近一次触发的时间和依据
      await trx
        .insertInto('follow_up_items')
        .values({
          ...scope,
          kind: item.kind,
          severity: item.severity,
          domain: item.domain,
          metric: item.metric,
          basis: JSON.stringify(item.basis),
          source_ref: JSON.stringify(sourceRef),
          dedupe_key: item.dedupeKey,
        })
        .onConflict((oc) =>
          oc
            .columns(['client_id', 'dedupe_key'])
            .where('status', 'in', ['open', 'snoozed'])
            .doUpdateSet((eb) => ({
              severity: eb.ref('excluded.severity'),
              basis: eb.ref('excluded.basis'),
              source_ref: eb.ref('excluded.source_ref'),
              last_triggered_at: new Date(),
            })),
        )
        .execute();
    }

    await trx
      .insertInto('twin_compute_state')
      .values({ ...scope, computed_at: loaded.loadAt })
      .onConflict((oc) => oc.column('client_id').doUpdateSet({ computed_at: loaded.loadAt }))
      .execute();

    return {
      outcome: 'done',
      statusRows,
      forecasts: plan.forecasts.length,
      followUps: plan.followUps.length,
    };
  }
}

/** 预测表的一行还原成 forecastMetric 的结果（偏离判断要用拟合参数） */
export function forecastFromRow(f: {
  metric: string;
  source: 'report' | 'monitoring';
  method_version: string;
  interval_level: string;
  status: 'ok' | 'insufficient_data';
  insufficient_reason: ForecastResult['insufficientReason'];
  points_needed: number | null;
  n_points: number;
  span_days: number;
  horizon_months: 3 | 6 | null;
  uncertainty: 'normal' | 'high' | null;
  basis: unknown;
  fit: unknown;
  points: unknown;
}): ForecastResult {
  return {
    metric: f.metric,
    source: f.source,
    methodVersion: f.method_version,
    intervalLevel: Number(f.interval_level),
    status: f.status,
    insufficientReason: f.insufficient_reason,
    pointsNeeded: f.points_needed,
    nPoints: f.n_points,
    spanDays: f.span_days,
    horizonMonths: f.horizon_months === null ? null : (Number(f.horizon_months) as 3 | 6),
    uncertainty: f.uncertainty,
    basis: (f.basis as ForecastResult['basis']) ?? null,
    fit: (f.fit as ForecastResult['fit']) ?? null,
    points: (f.points as ForecastResult['points']) ?? [],
  };
}
