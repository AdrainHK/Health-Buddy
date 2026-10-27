import { Inject, Injectable } from '@nestjs/common';
import {
  FORECAST_METRICS,
  TWIN_DOMAINS,
  MANUAL_READINGS_LIST_LIMIT,
  TWIN_TIMELINE_ORG_ADMIN_TYPES,
  domainMetrics,
  indicatorUnit,
  matchesRule,
  weeklyAverages,
  worstTwinLevel,
  type CreateMonitoringReadingRequest,
  type CriticalComparator,
  type IndicatorCode,
  type MonitoringReading,
  type SetTwinStatusRequest,
  type TwinBasisItem,
  type TwinClientLevel,
  type TwinDomain,
  type TwinDomainView,
  type TwinForecast,
  type TwinForecastDetailResponse,
  type TwinLevel,
  type TwinOrgAdminResponse,
  type TwinResponse,
  type TwinStatusRecord,
  type PlanSection,
  type TwinTimelineEvent,
  type TwinTimelineQuery,
  type TwinTimelineResponse,
  type TwinTimelineType,
  type TwinRef,
} from '@health-buddy/shared';
import type {
  TwinFollowUpSnapshot,
  TwinForecastSnapshot,
  TwinSnapshot,
} from '@health-buddy/skills';
import { forecastCrossings } from '@health-buddy/skills';
import { selectTiers, toTier } from '../clients/client-record.repository.js';
import { selectClientSummary, toClientSummary } from '../clients/clients.repository.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { twinRecordOpen } from '../db/twin-functions.js';
import { criticalReportIds } from '../reports/reports.repository.js';
import { forecastFromRow } from './twin-engine.js';
import { latestDomainDataAt } from './twin-plan.js';

const HISTORY_ROW_LIMIT = 2000;
const STATUS_HISTORY_LIMIT = 200;
const DETAIL_REPORT_LIMIT = 500;
const DETAIL_READING_LIMIT = 5000;
const DETAIL_READING_DAYS = 26 * 7 + 7;
const TIMELINE_READING_LIMIT = 3000;
const DAY_MS = 86_400_000;

type StatusRow = {
  id: string;
  domain: TwinDomain;
  level: TwinLevel;
  origin: 'computed' | 'manual' | 'manual_cleared';
  basis: unknown;
  rules_version: number;
  reason: string | null;
  manual_expires: 'next_data' | 'never' | null;
  trigger: TwinStatusRecord['trigger'];
  set_by: string | null;
  set_by_name: string | null;
  created_at: Date;
};

function selectStatusRows(trx: TenantTransaction, clientId: string) {
  return trx
    .selectFrom('twin_status_history as h')
    .leftJoin('users as u', 'u.id', 'h.set_by')
    .select([
      'h.id',
      'h.domain',
      'h.level',
      'h.origin',
      'h.basis',
      'h.rules_version',
      'h.reason',
      'h.manual_expires',
      'h.trigger',
      'h.set_by',
      'u.display_name as set_by_name',
      'h.created_at',
    ])
    .where('h.client_id', '=', clientId);
}

function toStatusRecord(row: StatusRow): TwinStatusRecord {
  return {
    id: row.id,
    domain: row.domain,
    level: row.level,
    origin: row.origin,
    basis: (Array.isArray(row.basis) ? row.basis : []) as TwinBasisItem[],
    rulesVersion: row.rules_version,
    reason: row.reason,
    manualExpires: row.manual_expires,
    trigger: row.trigger,
    setBy: row.set_by,
    setByName: row.set_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 每个方面的当前状态（2.3）：系统计算和手动调整同时保留；
 * 手动调整到这个方面下次有新数据时失效（Q4），失效后恢复系统计算并标记提示。
 * rows 为同一位客户的状态历史，从新到旧。
 */
export function buildDomainViews(
  rows: readonly StatusRow[],
  latestDataAt: ReadonlyMap<TwinDomain, number>,
): TwinDomainView[] {
  return TWIN_DOMAINS.map((domain) => {
    const mine = rows.filter((r) => r.domain === domain);
    const computedRows = mine.filter((r) => r.origin === 'computed');
    const computed = computedRows[0];
    let previousLevel: TwinLevel | null = null;
    let changedAt: string | null = null;
    if (computed) {
      for (let i = 1; i < computedRows.length; i++) {
        if (computedRows[i]!.level !== computed.level) {
          previousLevel = computedRows[i]!.level;
          changedAt = computedRows[i - 1]!.created_at.toISOString();
          break;
        }
      }
    }
    const lastManual = mine.find((r) => r.origin !== 'computed');
    let manual: StatusRow | undefined;
    let manualExpiredByNewData = false;
    if (lastManual?.origin === 'manual') {
      const expired =
        lastManual.manual_expires === 'next_data' &&
        (latestDataAt.get(domain) ?? 0) > lastManual.created_at.getTime();
      if (expired) manualExpiredByNewData = true;
      else manual = lastManual;
    }
    return {
      domain,
      level: manual?.level ?? computed?.level ?? 'unknown',
      computed: computed ? toStatusRecord(computed) : null,
      manual: manual ? toStatusRecord(manual) : null,
      manualExpiredByNewData,
      previousLevel,
      changedAt,
    };
  });
}

type ForecastRow = Parameters<typeof forecastFromRow>[0] & { id: string; computed_at: Date };

function toTwinForecast(row: ForecastRow): TwinForecast {
  const { fit, ...rest } = forecastFromRow(row);
  void fit; // 拟合参数只在后端用，不返回
  return { ...rest, id: row.id, computedAt: row.computed_at.toISOString() };
}

/**
 * 孪生的读写（M4 规格 2.2–2.5、7.4）。可见范围由行级安全决定：
 * 健管师只看自己的客户；机构管理员只读本机构客户的状态历史（Q20），预测、跟进清单查不到；
 * 运营商和平台什么都查不到。查不到客户时返回 undefined，接口按 404 处理。
 */
@Injectable()
export class TwinRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 健管师的孪生主视图 */
  managerView(
    ctx: TenantContext,
    clientId: string,
  ): Promise<{ view: TwinResponse; neverComputed: boolean } | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const core = await this.core(trx, ctx, clientId);
      if (!core) return undefined;
      const forecasts = await trx
        .selectFrom('twin_forecasts')
        .selectAll()
        .where('client_id', '=', clientId)
        .where('superseded_at', 'is', null)
        .orderBy('metric')
        .orderBy('source')
        .execute();
      const open = await trx
        .selectFrom('follow_up_items')
        .select(['kind'])
        .where('client_id', '=', clientId)
        .where('status', 'in', ['open', 'snoozed'])
        .execute();
      const state = await trx
        .selectFrom('twin_compute_state')
        .select(['requested_at', 'computed_at'])
        .where('client_id', '=', clientId)
        .executeTakeFirst();
      const computing = state
        ? Boolean(
            state.requested_at &&
            (!state.computed_at || state.requested_at.getTime() > state.computed_at.getTime()),
          )
        : core.hasData;
      await twinRecordOpen(trx);
      return {
        neverComputed: !state,
        view: {
          client: core.client,
          domains: core.domains,
          riskTier: core.riskTier,
          forecasts: forecasts.map((f) => toTwinForecast(f as ForecastRow)),
          openFollowUpCount: open.length,
          hasOpenCritical: open.some((o) => o.kind === 'critical'),
          computing: computing && core.hasData,
          hasData: core.hasData,
        },
      };
    });
  }

  /** 机构管理员的孪生（Q20）：只有画像、状态和分层，单独的 schema */
  orgAdminView(ctx: TenantContext, clientId: string): Promise<TwinOrgAdminResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const core = await this.core(trx, ctx, clientId);
      if (!core) return undefined;
      await twinRecordOpen(trx);
      return {
        client: core.client,
        domains: core.domains,
        riskTier: core.riskTier,
        hasData: core.hasData,
      };
    });
  }

  private async core(trx: TenantTransaction, ctx: TenantContext, clientId: string) {
    const client = await selectClientSummary(trx).where('id', '=', clientId).executeTakeFirst();
    if (!client) return undefined;
    const rows = await selectStatusRows(trx, clientId)
      .orderBy('h.created_at', 'desc')
      .orderBy('h.id', 'desc')
      .limit(HISTORY_ROW_LIMIT)
      .execute();
    const latest = await this.latestDataAt(trx, clientId);
    const tier = await selectTiers(trx, clientId).limit(1).executeTakeFirst();
    return {
      client: toClientSummary(client),
      domains: buildDomainViews(rows as StatusRow[], latest.byDomain),
      riskTier: tier ? toTier(tier, ctx.role) : null,
      hasData: latest.hasData,
    };
  }

  /** 每个方面最近一次有新数据写入的时间，和客户有没有任何已核对报告、监测数据 */
  private latestDataAt(trx: TenantTransaction, clientId: string) {
    return latestDataAt(trx, clientId);
  }

  /** 某个方面（或全部）的状态历史，从新到旧 */
  statusHistory(
    ctx: TenantContext,
    clientId: string,
    domain: TwinDomain | undefined,
  ): Promise<TwinStatusRecord[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      let q = selectStatusRows(trx, clientId);
      if (domain) q = q.where('h.domain', '=', domain);
      const rows = await q
        .orderBy('h.created_at', 'desc')
        .orderBy('h.id', 'desc')
        .limit(STATUS_HISTORY_LIMIT)
        .execute();
      return rows.map((r) => toStatusRecord(r as StatusRow));
    });
  }

  /**
   * 手动调整状态（2.3，Q4）：追加一行 manual，理由必填，到这个方面下次有新数据时失效。
   * 依据沿用当前系统计算的依据。只能调整自己的客户，租户列只取自当前会话。
   */
  setManual(
    ctx: TenantContext,
    clientId: string,
    input: SetTwinStatusRequest,
  ): Promise<TwinDomainView | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const computed = await trx
        .selectFrom('twin_status_history')
        .select(['basis', 'rules_version'])
        .where('client_id', '=', clientId)
        .where('domain', '=', input.domain)
        .where('origin', '=', 'computed')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      const version = await trx
        .selectFrom('twin_rules_version')
        .select('version')
        .executeTakeFirst();
      await trx
        .insertInto('twin_status_history')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          domain: input.domain,
          level: input.level,
          origin: 'manual',
          basis: JSON.stringify(computed?.basis ?? []),
          rules_version: computed?.rules_version ?? version?.version ?? 0,
          reason: input.reason,
          manual_expires: input.expires,
          trigger: 'manual',
          set_by: ctx.userId,
        })
        .execute();
      return this.domainView(trx, clientId, input.domain);
    });
  }

  /**
   * 取消手动调整，恢复系统计算。没有生效中的手动调整时返回 'none'（409）。
   */
  clearManual(
    ctx: TenantContext,
    clientId: string,
    domain: TwinDomain,
  ): Promise<TwinDomainView | 'none' | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const view = await this.domainView(trx, clientId, domain);
      if (!view.manual) return 'none';
      await trx
        .insertInto('twin_status_history')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          domain,
          level: view.computed?.level ?? 'unknown',
          origin: 'manual_cleared',
          basis: JSON.stringify(view.computed?.basis ?? []),
          rules_version: view.manual.rulesVersion,
          trigger: 'manual',
          set_by: ctx.userId,
        })
        .execute();
      return this.domainView(trx, clientId, domain);
    });
  }

  private async domainView(
    trx: TenantTransaction,
    clientId: string,
    domain: TwinDomain,
  ): Promise<TwinDomainView> {
    const rows = await selectStatusRows(trx, clientId)
      .where('h.domain', '=', domain)
      .orderBy('h.created_at', 'desc')
      .orderBy('h.id', 'desc')
      .limit(HISTORY_ROW_LIMIT)
      .execute();
    const latest = await this.latestDataAt(trx, clientId);
    return buildDomainViews(rows as StatusRow[], latest.byDomain).find((d) => d.domain === domain)!;
  }

  /** 预测大图（2.4）：历次实际数值和最新预测。只给健管师（Q20） */
  forecastDetail(
    ctx: TenantContext,
    clientId: string,
    metric: string,
  ): Promise<TwinForecastDetailResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager' || !(await clientVisible(trx, clientId))) return undefined;
      if (!(FORECAST_METRICS as readonly string[]).includes(metric)) return undefined;
      const reports = await trx
        .selectFrom('report_indicators as i')
        .innerJoin('health_reports as r', (join) =>
          join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
        )
        .select((eb) => [
          'i.value',
          'i.unit',
          'i.ref_low',
          'i.ref_high',
          eb
            .fn<string>('to_char', [eb.ref('r.report_date'), eb.val('YYYY-MM-DD')])
            .as('report_date'),
        ])
        .where('i.client_id', '=', clientId)
        .where('i.code', '=', metric)
        .where('i.superseded_by', 'is', null)
        .where('i.value', 'is not', null)
        .orderBy('r.report_date', 'desc')
        .orderBy('i.created_at', 'desc')
        .limit(DETAIL_REPORT_LIMIT)
        .execute();
      const readings = await trx
        .selectFrom('monitoring_readings')
        .select(['value', 'unit', 'measured_at', 'source'])
        .where('client_id', '=', clientId)
        .where('metric', '=', metric)
        .where('measured_at', '>=', new Date(Date.now() - DETAIL_READING_DAYS * DAY_MS))
        .orderBy('measured_at', 'desc')
        .limit(DETAIL_READING_LIMIT)
        .execute();
      const forecasts = await trx
        .selectFrom('twin_forecasts')
        .selectAll()
        .where('client_id', '=', clientId)
        .where('metric', '=', metric)
        .where('superseded_at', 'is', null)
        .orderBy('source')
        .execute();
      const unit = indicatorUnit(metric as IndicatorCode);
      const actual = [
        ...reports
          .filter((r) => r.unit === unit)
          .map((r) => ({
            at: `${r.report_date}T00:00:00.000Z`,
            value: Number(r.value),
            source: 'report' as const,
            manual: false,
          })),
        ...readings
          .filter((r) => r.unit === unit)
          .map((r) => ({
            at: r.measured_at.toISOString(),
            value: Number(r.value),
            source: 'monitoring' as const,
            manual: r.source === 'manual',
          })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const withRef = reports.find((r) => r.ref_low !== null || r.ref_high !== null);
      return {
        metric,
        unit,
        actual,
        forecasts: forecasts.map((f) => toTwinForecast(f as ForecastRow)),
        reference: withRef
          ? {
              low: withRef.ref_low === null ? null : Number(withRef.ref_low),
              high: withRef.ref_high === null ? null : Number(withRef.ref_high),
            }
          : null,
      };
    });
  }

  /**
   * 时间轴（2.5）：按时间倒序分页。机构管理员只有基于已核对数据的事件（Q20），
   * 产物、专家、跟进类事件不查（行级安全也查不到）。
   */
  timeline(
    ctx: TenantContext,
    clientId: string,
    query: TwinTimelineQuery,
  ): Promise<TwinTimelineResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const allowed: readonly TwinTimelineType[] =
        ctx.role === 'manager'
          ? [
              'report',
              'monitoring_alert',
              'correction',
              'health_history',
              'risk_tier',
              'status_change',
              'follow_up',
              'expert',
              'artifact',
              'care_plan',
              'visit',
              'visit_record',
            ]
          : TWIN_TIMELINE_ORG_ADMIN_TYPES;
      const types = new Set(
        (query.types?.length ? query.types : allowed).filter((t) => allowed.includes(t)),
      );
      const before = query.before ? new Date(query.before) : new Date(Date.now() + 60_000);
      const n = query.limit + 1;
      const events: TwinTimelineEvent[] = [];
      const iso = (d: Date | string) => new Date(d).toISOString();

      if (types.has('report')) {
        const rows = await trx
          .selectFrom('health_reports as r')
          .select((eb) => [
            'r.id',
            eb.fn.coalesce('r.verified_at', 'r.created_at').as('at'),
            eb
              .fn<string>('to_char', [eb.ref('r.report_date'), eb.val('YYYY-MM-DD')])
              .as('report_date'),
            eb
              .selectFrom('report_indicators as i')
              .select((e) => e.fn.countAll<string>().as('n'))
              .whereRef('i.report_id', '=', 'r.id')
              .where('i.superseded_by', 'is', null)
              .where('i.abnormal', 'in', ['high', 'low'])
              .as('abnormal_count'),
          ])
          .where('r.client_id', '=', clientId)
          .where((eb) => eb(eb.fn.coalesce('r.verified_at', 'r.created_at'), '<', before))
          .orderBy('at', 'desc')
          .limit(n)
          .execute();
        const critical = await criticalReportIds(
          trx,
          rows.map((r) => r.id),
        );
        for (const r of rows)
          events.push({
            type: 'report',
            id: `report:${r.id}`,
            at: iso(r.at),
            reportId: r.id,
            reportDate: r.report_date,
            abnormalCount: Number(r.abnormal_count ?? 0),
            hasCritical: critical.has(r.id),
          });
      }

      if (types.has('monitoring_alert')) {
        const rules = await trx
          .selectFrom('critical_thresholds')
          .select(['metric', 'comparator', 'value', 'enabled'])
          .where('enabled', '=', true)
          .execute();
        const metrics = [...new Set(rules.map((r) => r.metric))];
        if (metrics.length) {
          const rows = await trx
            .selectFrom('monitoring_readings')
            .select(['metric', 'value', 'unit', 'measured_at'])
            .where('client_id', '=', clientId)
            .where('metric', 'in', metrics)
            .where('measured_at', '<', before)
            .orderBy('measured_at', 'desc')
            .limit(TIMELINE_READING_LIMIT)
            .execute();
          // 每天同一指标最多一条，避免刷屏
          const seen = new Set<string>();
          for (const r of rows) {
            if (r.unit !== indicatorUnit(r.metric as IndicatorCode)) continue;
            const value = Number(r.value);
            const hit = rules.some(
              (rule) =>
                rule.metric === r.metric &&
                matchesRule(
                  { comparator: rule.comparator as CriticalComparator, value: Number(rule.value) },
                  value,
                ),
            );
            if (!hit) continue;
            const day = r.measured_at.toISOString().slice(0, 10);
            const key = `${r.metric}:${day}`;
            if (seen.has(key)) continue;
            seen.add(key);
            events.push({
              type: 'monitoring_alert',
              id: `monitoring_alert:${key}`,
              at: iso(r.measured_at),
              metric: r.metric,
              date: day,
              method: 'critical',
              level: 'red',
            });
            if (seen.size >= n) break;
          }
        }
      }

      if (types.has('correction')) {
        const rows = await trx
          .selectFrom('report_events as e')
          .leftJoin('report_indicators as i', 'i.id', 'e.indicator_id')
          .leftJoin('users as u', 'u.id', 'e.actor_id')
          .select(['e.id', 'e.created_at', 'e.report_id', 'i.code', 'u.display_name'])
          .where('e.client_id', '=', clientId)
          .where('e.action', '=', 'corrected')
          .where('e.report_id', 'is not', null)
          .where('e.created_at', '<', before)
          .orderBy('e.created_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'correction',
            id: `correction:${r.id}`,
            at: iso(r.created_at),
            reportId: r.report_id!,
            metric: r.code ?? null,
            actorName: r.display_name ?? null,
          });
      }

      if (types.has('health_history')) {
        const rows = await trx
          .selectFrom('client_health_history')
          .select(['id', 'category', 'content', 'created_at', 'updated_at'])
          .where('client_id', '=', clientId)
          .where('deleted_at', 'is', null)
          .where('updated_at', '<', before)
          .orderBy('updated_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'health_history',
            id: `health_history:${r.id}`,
            at: iso(r.updated_at),
            category: r.category,
            summary: r.content.length > 80 ? `${r.content.slice(0, 80)}…` : r.content,
            action: r.updated_at.getTime() > r.created_at.getTime() ? 'updated' : 'created',
          });
      }

      if (types.has('risk_tier')) {
        const rows = await selectTiers(trx, clientId)
          .where('t.set_at', '<', before)
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'risk_tier',
            id: `risk_tier:${r.id}`,
            at: iso(r.set_at),
            tier: r.tier,
            reason: r.reason,
            setByName: r.set_by_name,
          });
      }

      if (types.has('status_change')) {
        // 只列颜色有变化的系统计算，以及手动调整、取消调整；依据更新但颜色没变的不进时间轴
        const rows = await trx
          .selectFrom('twin_status_history')
          .select(['id', 'domain', 'level', 'origin', 'trigger', 'created_at'])
          .where('client_id', '=', clientId)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .limit(HISTORY_ROW_LIMIT * 4)
          .execute();
        const last = new Map<string, TwinLevel>();
        const changes: TwinTimelineEvent[] = [];
        for (const r of rows) {
          const key = `${r.domain}:${r.origin === 'computed' ? 'computed' : 'manual'}`;
          const from = last.get(`${r.domain}:shown`) ?? null;
          if (r.origin === 'computed') {
            const prev = last.get(key) ?? null;
            last.set(key, r.level);
            if (prev === r.level) continue;
            changes.push({
              type: 'status_change',
              id: `status_change:${r.id}`,
              at: iso(r.created_at),
              domain: r.domain,
              from: prev,
              to: r.level,
              origin: r.origin,
              trigger: r.trigger,
            });
          } else {
            changes.push({
              type: 'status_change',
              id: `status_change:${r.id}`,
              at: iso(r.created_at),
              domain: r.domain,
              from,
              to: r.level,
              origin: r.origin,
              trigger: r.trigger,
            });
          }
          last.set(`${r.domain}:shown`, r.level);
        }
        events.push(
          ...changes
            .filter((e) => Date.parse(e.at) < before.getTime())
            .reverse()
            .slice(0, n),
        );
      }

      if (types.has('follow_up')) {
        const rows = await trx
          .selectFrom('follow_up_events as e')
          .innerJoin('follow_up_items as i', 'i.id', 'e.item_id')
          .select([
            'e.id',
            'e.action',
            'e.created_at',
            'i.id as item_id',
            'i.kind',
            'i.status',
            'i.resolution',
            'i.dismiss_reason',
          ])
          .where('e.client_id', '=', clientId)
          .where('e.action', 'in', ['created', 'done', 'snoozed', 'dismissed', 'reopened'])
          .where('e.created_at', '<', before)
          .orderBy('e.created_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'follow_up',
            id: `follow_up:${r.id}`,
            at: iso(r.created_at),
            itemId: r.item_id,
            kind: r.kind,
            action: r.action as 'created' | 'done' | 'snoozed' | 'dismissed' | 'reopened',
            resolution: r.action === 'done' && r.status === 'done' ? r.resolution : null,
            dismissReason:
              r.action === 'dismissed' && r.status === 'dismissed' ? r.dismiss_reason : null,
          });
      }

      if (types.has('expert')) {
        const rows = await trx
          .selectFrom('expert_consultations as c')
          .select((eb) => [
            'c.id',
            'c.task_id',
            'c.trigger',
            'c.created_at',
            eb
              .selectFrom('expert_calls as x')
              .select((e) =>
                e.fn.agg<string[] | null>('array_agg', ['x.expert_id']).distinct().as('ids'),
              )
              .whereRef('x.consultation_id', '=', 'c.id')
              .as('expert_ids'),
          ])
          .where('c.client_id', '=', clientId)
          .where('c.created_at', '<', before)
          .orderBy('c.created_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'expert',
            id: `expert:${r.id}`,
            at: iso(r.created_at),
            consultationId: r.id,
            taskId: r.task_id,
            trigger: r.trigger,
            expertIds: r.expert_ids ?? [],
          });
      }

      if (types.has('artifact')) {
        const rows = await trx
          .selectFrom('artifact_events as e')
          .innerJoin('artifacts as a', 'a.id', 'e.artifact_id')
          .select([
            'e.id',
            'e.action',
            'e.created_at',
            'a.id as artifact_id',
            'a.task_id',
            'a.kind',
          ])
          .where('a.client_id', '=', clientId)
          .where('e.action', 'in', ['approved', 'copied', 'exported'])
          .where('e.created_at', '<', before)
          .orderBy('e.created_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'artifact',
            id: `artifact:${r.id}`,
            at: iso(r.created_at),
            artifactId: r.artifact_id,
            taskId: r.task_id,
            kind: r.kind,
            action: r.action as 'approved' | 'copied' | 'exported',
          });
      }

      // M5：方案生效、结束、被替代（只显示部分和原因，不显示方案文字）
      if (types.has('care_plan')) {
        const rows = await trx
          .selectFrom('care_plans')
          .select(['id', 'sections', 'status', 'end_reason', 'approved_at', 'ended_at'])
          .where('client_id', '=', clientId)
          .where((eb) => eb.or([eb('approved_at', '<', before), eb('ended_at', '<', before)]))
          .orderBy('approved_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows) {
          const sections = r.sections as PlanSection[];
          if (r.approved_at < before)
            events.push({
              type: 'care_plan',
              id: `care_plan:${r.id}:activated`,
              at: iso(r.approved_at),
              planId: r.id,
              action: 'activated',
              sections,
              endReason: null,
            });
          if (r.ended_at && r.ended_at < before && r.status !== 'active')
            events.push({
              type: 'care_plan',
              id: `care_plan:${r.id}:${r.status}`,
              at: iso(r.ended_at),
              planId: r.id,
              action: r.status,
              sections,
              endReason: r.end_reason,
            });
        }
      }

      // M5：随访完成、未联系上、取消（不显示重点和备注）
      if (types.has('visit')) {
        const rows = await trx
          .selectFrom('visit_events as e')
          .innerJoin('visits as v', 'v.id', 'e.visit_id')
          .select(['e.id', 'e.action', 'e.created_at', 'v.id as visit_id', 'v.method', 'v.purpose'])
          .where('e.client_id', '=', clientId)
          .where('e.action', 'in', ['done', 'missed', 'cancelled'])
          .where('e.created_at', '<', before)
          .orderBy('e.created_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows)
          events.push({
            type: 'visit',
            id: `visit:${r.id}`,
            at: iso(r.created_at),
            visitId: r.visit_id,
            action: r.action as 'done' | 'missed' | 'cancelled',
            method: r.method,
            purpose: r.purpose,
          });
      }

      // M5：随访记录确认（日期、方式和摘要的前 50 字）
      if (types.has('visit_record')) {
        const rows = await trx
          .selectFrom('visit_records')
          .select((eb) => [
            'id',
            'method',
            'snapshot',
            'approved_at',
            eb.fn<string>('to_char', [eb.ref('visit_date'), eb.val('YYYY-MM-DD')]).as('visit_date'),
          ])
          .where('client_id', '=', clientId)
          .where('approved_at', '<', before)
          .orderBy('approved_at', 'desc')
          .limit(n)
          .execute();
        for (const r of rows) {
          const summary = (r.snapshot as { summary?: unknown } | null)?.summary;
          events.push({
            type: 'visit_record',
            id: `visit_record:${r.id}`,
            at: iso(r.approved_at),
            recordId: r.id,
            visitDate: r.visit_date,
            method: r.method,
            excerpt: Array.from(typeof summary === 'string' ? summary : '')
              .slice(0, 50)
              .join(''),
          });
        }
      }

      events.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      const page = events.slice(0, query.limit);
      return {
        events: page,
        nextBefore: events.length > query.limit ? page[page.length - 1]!.at : null,
      };
    });
  }

  /**
   * 左侧栏客户列表的状态圆点（2.1）：当前健管师每位客户四个方面里最严重的状态，
   * 有效的手动调整优先（和孪生主视图同一套 buildDomainViews）。
   * 每个方面每种来源只取最近一行，不读全部历史。
   * 不记孪生打开次数（这不是打开孪生）。只给健管师，其他角色返回空列表（接口按 404 处理）。
   */
  clientLevels(ctx: TenantContext): Promise<TwinClientLevel[]> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return [];
      const clients = await trx
        .selectFrom('clients')
        .select('id')
        .where('manager_id', '=', ctx.userId)
        .orderBy('id')
        .execute();
      if (clients.length === 0) return [];
      const clientIds = clients.map((c) => c.id);
      const rows = await trx
        .selectFrom('twin_status_history as h')
        .leftJoin('users as u', 'u.id', 'h.set_by')
        // 每位客户、每个方面、每种来源（系统计算、手动调整、取消调整）只取最近一行
        .distinctOn(['h.client_id', 'h.domain', 'h.origin'])
        .select([
          'h.client_id',
          'h.id',
          'h.domain',
          'h.level',
          'h.origin',
          'h.basis',
          'h.rules_version',
          'h.reason',
          'h.manual_expires',
          'h.trigger',
          'h.set_by',
          'u.display_name as set_by_name',
          'h.created_at',
        ])
        .where('h.client_id', 'in', clientIds)
        .orderBy('h.client_id')
        .orderBy('h.domain')
        .orderBy('h.origin')
        .orderBy('h.created_at', 'desc')
        .orderBy('h.id', 'desc')
        .execute();
      const report = await trx
        .selectFrom('report_indicators')
        .select(['client_id', 'code', (eb) => eb.fn.max('created_at').as('at')])
        .where('client_id', 'in', clientIds)
        .where('code', 'is not', null)
        .where('value', 'is not', null)
        .groupBy(['client_id', 'code'])
        .execute();
      const readings = await trx
        .selectFrom('monitoring_readings')
        .select(['client_id', 'metric', (eb) => eb.fn.max('created_at').as('at')])
        .where('client_id', 'in', clientIds)
        .groupBy(['client_id', 'metric'])
        .execute();
      return clientIds.map((clientId) => {
        const mine = (rows as (StatusRow & { client_id: string })[])
          .filter((r) => r.client_id === clientId)
          .sort(
            (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1),
          );
        const reportAt = new Map(
          report
            .filter((r) => r.client_id === clientId)
            .map((r) => [r.code!, new Date(r.at).getTime()]),
        );
        const readingAt = new Map(
          readings
            .filter((r) => r.client_id === clientId)
            .map((r) => [r.metric, new Date(r.at).getTime()]),
        );
        const views = buildDomainViews(
          mine,
          latestDomainDataAt(reportAt, readingAt, domainMetrics),
        );
        return { clientId, level: worstTwinLevel(views.map((v) => v.level)) };
      });
    });
  }

  /**
   * 当前健管师自己给这位客户手动录入的读数（Q29），按测量时间从新到旧，最多 50 条。
   * 只有服务这位客户的健管师能看；别人的客户、机构管理员返回 undefined（404）。
   */
  manualReadings(ctx: TenantContext, clientId: string): Promise<MonitoringReading[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager' || !(await clientVisible(trx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('monitoring_readings')
        .select([
          'id',
          'client_id',
          'metric',
          'value',
          'unit',
          'measured_at',
          'source',
          'created_by',
        ])
        .where('client_id', '=', clientId)
        .where('source', '=', 'manual')
        .where('created_by', '=', ctx.userId)
        .orderBy('measured_at', 'desc')
        .orderBy('id', 'desc')
        .limit(MANUAL_READINGS_LIST_LIMIT)
        .execute();
      return rows.map((r) => toReading(r, ctx.userId));
    });
  }

  /** 健管师手动录入一条监测读数（Q29）。只能给自己的客户录入，单位跟目录走 */
  createReading(
    ctx: TenantContext,
    clientId: string,
    input: CreateMonitoringReadingRequest,
  ): Promise<MonitoringReading | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const row = await trx
        .insertInto('monitoring_readings')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          metric: input.metric,
          value: input.value,
          unit: indicatorUnit(input.metric),
          measured_at: new Date(input.measuredAt),
          source: 'manual',
          created_by: ctx.userId,
        })
        .returning([
          'id',
          'client_id',
          'metric',
          'value',
          'unit',
          'measured_at',
          'source',
          'created_by',
        ])
        .executeTakeFirstOrThrow();
      return toReading(row, ctx.userId);
    });
  }

  /**
   * 删除自己手动录入的读数。看不到 → 'not_found'（404）；不是自己手动录入的 → 'not_manual'（409）。
   * 成功时返回客户 id（用来重算）。
   */
  deleteReading(
    ctx: TenantContext,
    readingId: string,
  ): Promise<{ clientId: string } | 'not_found' | 'not_manual'> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return 'not_found';
      const row = await trx
        .selectFrom('monitoring_readings')
        .select(['id', 'client_id', 'source', 'created_by'])
        .where('id', '=', readingId)
        .executeTakeFirst();
      if (!row) return 'not_found';
      if (row.source !== 'manual' || row.created_by !== ctx.userId) return 'not_manual';
      if (!(await ownClient(trx, ctx, row.client_id))) return 'not_found';
      await trx.deleteFrom('monitoring_readings').where('id', '=', readingId).execute();
      return { clientId: row.client_id };
    });
  }
}

function toReading(
  row: {
    id: string;
    client_id: string;
    metric: string;
    value: string;
    unit: string;
    measured_at: Date;
    source: MonitoringReading['source'];
    created_by: string | null;
  },
  userId: string,
): MonitoringReading {
  return {
    id: String(row.id),
    clientId: row.client_id,
    metric: row.metric,
    value: Number(row.value),
    unit: row.unit,
    measuredAt: row.measured_at.toISOString(),
    source: row.source,
    deletable: row.source === 'manual' && row.created_by === userId,
  };
}

/** 每个方面最近一次有新数据写入的时间，和客户有没有任何已核对报告、监测数据 */
async function latestDataAt(trx: TenantTransaction, clientId: string) {
  const report = await trx
    .selectFrom('report_indicators')
    .select(['code', (eb) => eb.fn.max('created_at').as('at')])
    .where('client_id', '=', clientId)
    .where('code', 'is not', null)
    .where('value', 'is not', null)
    .groupBy('code')
    .execute();
  const readings = await trx
    .selectFrom('monitoring_readings')
    .select(['metric', (eb) => eb.fn.max('created_at').as('at')])
    .where('client_id', '=', clientId)
    .groupBy('metric')
    .execute();
  const reportAt = new Map(report.map((r) => [r.code!, new Date(r.at).getTime()]));
  const readingAt = new Map(readings.map((r) => [r.metric, new Date(r.at).getTime()]));
  return {
    byDomain: latestDomainDataAt(reportAt, readingAt, domainMetrics),
    hasData: report.length > 0 || readings.length > 0,
  };
}

/** 孪生快照里每个指标最多带几次历史数值 */
const SNAPSHOT_HISTORY_LIMIT = 12;

/**
 * 给模型的孪生快照（M4 规格 5.2）：四个方面的状态和依据、当前预测（含历次数值）、本人未处理的跟进项。
 * 在调用者的租户上下文里读，行级安全决定可见范围；数值、理由和备注只进内存，组装提示词前由
 * 生成服务去标识（redactTwin），不写日志。客户看不到时返回 undefined。
 */
export async function loadTwinSnapshot(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
  focus: readonly TwinRef[] = [],
  now = new Date(),
): Promise<TwinSnapshot | undefined> {
  if (ctx.role !== 'manager' || !(await clientVisible(trx, clientId))) return undefined;
  const rows = await selectStatusRows(trx, clientId)
    .orderBy('h.created_at', 'desc')
    .orderBy('h.id', 'desc')
    .limit(HISTORY_ROW_LIMIT)
    .execute();
  const latest = await latestDataAt(trx, clientId);
  const domains = buildDomainViews(rows as StatusRow[], latest.byDomain).map((d) => ({
    domain: d.domain,
    level: d.level,
    computedLevel: d.computed?.level ?? null,
    manual:
      d.manual && d.manual.level !== 'unknown'
        ? { level: d.manual.level, reason: d.manual.reason ?? '' }
        : null,
    previousLevel: d.previousLevel,
    changedOn: d.changedAt?.slice(0, 10) ?? null,
    basis: d.computed?.basis ?? [],
  }));

  const forecastRows = await trx
    .selectFrom('twin_forecasts')
    .selectAll()
    .where('client_id', '=', clientId)
    .where('superseded_at', 'is', null)
    .orderBy('metric')
    .orderBy('source')
    .execute();
  // 越线由后端算好给模型照抄（5.2）：危急阈值用平台启用的一套，参考范围用最近一份带范围的报告
  const thresholds = forecastRows.length
    ? await trx
        .selectFrom('critical_thresholds')
        .select(['metric', 'comparator', 'value', 'level'])
        .where('enabled', '=', true)
        .where(
          'metric',
          'in',
          forecastRows.map((r) => r.metric),
        )
        .execute()
    : [];
  const forecasts: TwinForecastSnapshot[] = [];
  for (const row of forecastRows) {
    const f = forecastFromRow(row as ForecastRow);
    const unit = indicatorUnit(f.metric as IndicatorCode);
    const reference =
      f.status === 'ok' ? await latestReference(trx, clientId, f.metric, unit) : null;
    const crossings =
      f.status === 'ok'
        ? forecastCrossings(
            f.points,
            reference,
            thresholds
              .filter((t) => t.metric === f.metric)
              .map((t) => ({ comparator: t.comparator, value: Number(t.value), level: t.level })),
          )
        : [];
    forecasts.push({
      metric: f.metric,
      source: f.source,
      unit,
      status: f.status,
      insufficientReason: f.insufficientReason,
      pointsNeeded: f.pointsNeeded,
      nPoints: f.nPoints,
      spanDays: f.spanDays,
      basis: f.basis ? { kind: f.basis.kind, from: f.basis.from, to: f.basis.to } : null,
      methodVersion: f.methodVersion,
      intervalLevel: f.intervalLevel,
      uncertainty: f.uncertainty,
      points: f.points.map((p) => ({
        monthsAhead: p.monthsAhead,
        date: p.date,
        mid: p.mid,
        low: p.low,
        high: p.high,
      })),
      history: await forecastHistory(trx, clientId, f.metric, f.source, unit, now),
      crossings,
    });
  }

  const items = await trx
    .selectFrom('follow_up_items')
    .select((eb) => [
      'follow_up_items.kind',
      'follow_up_items.severity',
      'follow_up_items.domain',
      'follow_up_items.metric',
      'follow_up_items.status',
      'follow_up_items.basis',
      'follow_up_items.note',
      eb
        .exists(
          eb
            .selectFrom('follow_up_events as e')
            .select('e.id')
            .whereRef('e.item_id', '=', 'follow_up_items.id')
            .where('e.action', '=', 'consulted'),
        )
        .as('consulted'),
    ])
    .where('client_id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .where('status', 'in', ['open', 'snoozed'])
    .orderBy('severity')
    .orderBy('last_triggered_at', 'desc')
    .limit(50)
    .execute();
  const followUps: TwinFollowUpSnapshot[] = items.map((i) => ({
    kind: i.kind,
    severity: i.severity,
    domain: i.domain,
    metric: i.metric,
    status: i.status as 'open' | 'snoozed',
    basis: (i.basis && typeof i.basis === 'object' ? i.basis : {}) as Record<string, unknown>,
    note: i.note,
    consulted: Boolean(i.consulted),
  }));
  return { domains, forecasts, followUps, focus: [...focus] };
}

/** 最近一份带参考范围的已核对报告里这个指标的参考范围（同一单位），没有为 null */
async function latestReference(
  trx: TenantTransaction,
  clientId: string,
  metric: string,
  unit: string,
): Promise<{ low: number | null; high: number | null } | null> {
  const row = await trx
    .selectFrom('report_indicators as i')
    .innerJoin('health_reports as r', (join) =>
      join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
    )
    .select(['i.ref_low', 'i.ref_high'])
    .where('i.client_id', '=', clientId)
    .where('i.code', '=', metric)
    .where('i.unit', '=', unit)
    .where('i.superseded_by', 'is', null)
    .where((eb) => eb.or([eb('i.ref_low', 'is not', null), eb('i.ref_high', 'is not', null)]))
    .orderBy('r.report_date', 'desc')
    .orderBy('i.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    low: row.ref_low === null ? null : Number(row.ref_low),
    high: row.ref_high === null ? null : Number(row.ref_high),
  };
}

/**
 * 预测指标的历次实际数值（5.2）：报告指标是已核对的数值（同一单位），监测指标是有效周的周平均
 * （保留一位小数），和预测用的口径一致。
 */
async function forecastHistory(
  trx: TenantTransaction,
  clientId: string,
  metric: string,
  source: 'report' | 'monitoring',
  unit: string,
  now: Date,
): Promise<{ date: string; value: number }[]> {
  if (source === 'report') {
    const rows = await trx
      .selectFrom('report_indicators as i')
      .innerJoin('health_reports as r', (join) =>
        join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
      )
      .select((eb) => [
        'i.value',
        eb.fn<string>('to_char', [eb.ref('r.report_date'), eb.val('YYYY-MM-DD')]).as('date'),
      ])
      .where('i.client_id', '=', clientId)
      .where('i.code', '=', metric)
      .where('i.unit', '=', unit)
      .where('i.superseded_by', 'is', null)
      .where('i.value', 'is not', null)
      .orderBy('r.report_date', 'desc')
      .limit(SNAPSHOT_HISTORY_LIMIT)
      .execute();
    return rows.reverse().map((r) => ({ date: r.date, value: Number(r.value) }));
  }
  const readings = await trx
    .selectFrom('monitoring_readings')
    .select(['value', 'measured_at'])
    .where('client_id', '=', clientId)
    .where('metric', '=', metric)
    .where('unit', '=', unit)
    .where('measured_at', '>=', new Date(now.getTime() - DETAIL_READING_DAYS * DAY_MS))
    // 读数多于上限时保留最近的（和预测大图一致），不让数据库随意挑
    .orderBy('measured_at', 'desc')
    .limit(DETAIL_READING_LIMIT)
    .execute();
  return weeklyAverages(
    readings.map((r) => ({ at: r.measured_at.toISOString(), value: Number(r.value) })),
    now.toISOString(),
  )
    .slice(-SNAPSHOT_HISTORY_LIMIT)
    .map((w) => ({ date: w.to, value: Math.round(w.average * 10) / 10 }));
}

export async function clientVisible(trx: TenantTransaction, clientId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .executeTakeFirst();
  return Boolean(row);
}

/** 只有服务这位客户的健管师能写。锁住客户行，和并发的转出串行 */
export async function ownClient(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
): Promise<boolean> {
  if (ctx.role !== 'manager') return false;
  const row = await trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .forShare()
    .executeTakeFirst();
  return Boolean(row);
}
