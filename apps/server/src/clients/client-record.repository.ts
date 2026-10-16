import { Inject, Injectable } from '@nestjs/common';
import {
  MONITORING_RECORD_DAYS,
  type ClientRecord,
  type CreateHealthHistoryItemRequest,
  type HealthHistoryItem,
  type IndicatorSeries,
  type MonitoringSeries,
  type RiskTierRecord,
  type SetRiskTierRequest,
  type UpdateHealthHistoryItemRequest,
} from '@health-buddy/shared';
import type { ExpressionBuilder } from 'kysely';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type { Database } from '../db/types.js';
import { selectArtifactSummary, toArtifactSummary } from '../tasks/tasks.repository.js';
import { selectReportList } from '../reports/reports.repository.js';
import { selectClientSummary, toClientSummary } from './clients.repository.js';

/** 档案里列出的上限，防止一位客户的数据把响应撑得太大 */
const REPORT_LIMIT = 100;
const INDICATOR_ROW_LIMIT = 2000;
const MONITORING_ROW_LIMIT = 5000;
const ARTIFACT_LIMIT = 100;
const HISTORY_LIMIT = 500;

/**
 * 统一客户档案：健康史、风险分层和档案汇总（M2 规格 2.2、2.7、3.2）。
 *
 * 可见范围由行级安全决定：健管师只看到自己客户的档案，机构管理员只读本机构客户的档案，
 * 运营商和平台什么都看不到。写入只对健管师开放（接口层也拦一道）。
 * 查不到客户时一律返回 undefined，接口按 404 处理。
 */
@Injectable()
export class ClientRecordRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  record(ctx: TenantContext, clientId: string): Promise<ClientRecord | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const client = await selectClientSummary(trx).where('id', '=', clientId).executeTakeFirst();
      if (!client) return undefined;

      const tiers = await selectTiers(trx, clientId).limit(1).execute();
      const history = await selectHistory(trx, clientId).execute();

      // 只有已核对的报告（待核对的识别结果不在 health_reports 里，规格 4.3 第 2 条）
      const reports = await selectReportList(trx, clientId).limit(REPORT_LIMIT).execute();

      const indicatorRows = await trx
        .selectFrom('report_indicators as i')
        .innerJoin('health_reports as r', (join) =>
          join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
        )
        .select((eb) => [
          'i.code',
          'i.value',
          'i.unit',
          'i.original_value',
          'i.original_unit',
          'i.ref_text',
          'i.abnormal',
          'r.id as report_id',
          'r.source',
          isoDate(eb, 'r.report_date').as('report_date'),
        ])
        .where('i.client_id', '=', clientId)
        // 趋势只看目录指标的当前值：更正掉的旧值、未收录指标不进趋势
        .where('i.superseded_by', 'is', null)
        .where('i.code', 'is not', null)
        .where('i.value', 'is not', null)
        .orderBy('i.code')
        .orderBy('r.report_date', 'desc')
        .orderBy('r.created_at', 'desc')
        .limit(INDICATOR_ROW_LIMIT)
        .execute();
      const indicators = new Map<string, IndicatorSeries>();
      for (const row of indicatorRows) {
        if (row.code === null) continue;
        const series = indicators.get(row.code) ?? { code: row.code, points: [] };
        series.points.push({
          reportId: row.report_id,
          reportDate: row.report_date,
          source: row.source,
          value: Number(row.value),
          unit: row.unit,
          originalValue: row.original_value,
          originalUnit: row.original_unit,
          refText: row.ref_text,
          abnormal: row.abnormal,
        });
        indicators.set(row.code, series);
      }

      const since = new Date(Date.now() - MONITORING_RECORD_DAYS * 24 * 60 * 60 * 1000);
      const readings = await trx
        .selectFrom('monitoring_readings')
        .select(['metric', 'value', 'unit', 'measured_at', 'source'])
        .where('client_id', '=', clientId)
        .where('measured_at', '>=', since)
        .orderBy('measured_at', 'desc')
        .limit(MONITORING_ROW_LIMIT)
        .execute();
      const monitoring = new Map<string, MonitoringSeries>();
      for (const r of readings) {
        const current = monitoring.get(r.metric);
        if (current) {
          current.count++;
          continue;
        }
        monitoring.set(r.metric, {
          metric: r.metric,
          unit: r.unit,
          count: 1,
          latest: {
            value: Number(r.value),
            measuredAt: r.measured_at.toISOString(),
            source: r.source,
          },
        });
      }

      // 产物只对健管师本人可见（行级安全）；机构管理员不查（Q14）
      const artifacts =
        ctx.role === 'manager'
          ? await selectArtifactSummary(trx)
              .where('client_id', '=', clientId)
              .orderBy('created_at', 'desc')
              .orderBy('version', 'desc')
              .limit(ARTIFACT_LIMIT)
              .execute()
          : [];

      return {
        client: toClientSummary(client),
        riskTier: tiers[0] ? toTier(tiers[0]) : null,
        healthHistory: history.map(toHistoryItem),
        reports: reports.map((r) => ({
          id: r.id,
          reportDate: r.report_date,
          source: r.source,
          institution: r.institution,
          indicatorCount: Number(r.indicator_count),
          abnormalCount: Number(r.abnormal_count),
        })),
        indicators: [...indicators.values()],
        monitoring: [...monitoring.values()].sort((a, b) => a.metric.localeCompare(b.metric)),
        artifacts: artifacts.map(toArtifactSummary),
        readOnly: ctx.role !== 'manager',
      };
    });
  }

  listHistory(ctx: TenantContext, clientId: string): Promise<HealthHistoryItem[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      return (await selectHistory(trx, clientId).execute()).map(toHistoryItem);
    });
  }

  createHistory(
    ctx: TenantContext,
    clientId: string,
    input: CreateHealthHistoryItemRequest,
  ): Promise<HealthHistoryItem | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const row = await trx
        .insertInto('client_health_history')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          category: input.category,
          content: input.content,
          recorded_on: input.recordedOn ?? null,
          created_by: ctx.userId,
        })
        .returning(historyColumns)
        .executeTakeFirstOrThrow();
      return toHistoryItem(row);
    });
  }

  /** 条目不属于这位客户、已删除或看不到时返回 undefined */
  updateHistory(
    ctx: TenantContext,
    clientId: string,
    itemId: string,
    input: UpdateHealthHistoryItemRequest,
  ): Promise<HealthHistoryItem | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const row = await trx
        .updateTable('client_health_history')
        .set({
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.recordedOn !== undefined ? { recorded_on: input.recordedOn } : {}),
        })
        .where('id', '=', itemId)
        .where('client_id', '=', clientId)
        .where('deleted_at', 'is', null)
        .returning(historyColumns)
        .executeTakeFirst();
      return row && toHistoryItem(row);
    });
  }

  /** 软删除。返回是否删掉了一条 */
  deleteHistory(ctx: TenantContext, clientId: string, itemId: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return false;
      const result = await trx
        .updateTable('client_health_history')
        .set({ deleted_at: new Date() })
        .where('id', '=', itemId)
        .where('client_id', '=', clientId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    });
  }

  listTiers(ctx: TenantContext, clientId: string): Promise<RiskTierRecord[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      return (await selectTiers(trx, clientId).limit(HISTORY_LIMIT).execute()).map(toTier);
    });
  }

  /** 手动设定分层，理由必填（规格 2.7）。写入一条新的历史记录，不改旧记录 */
  setTier(
    ctx: TenantContext,
    clientId: string,
    input: SetRiskTierRequest,
  ): Promise<RiskTierRecord | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const row = await trx
        .insertInto('client_risk_tiers')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          tier: input.tier,
          reason: input.reason,
          set_by: ctx.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const tier = await selectTiers(trx, clientId)
        .where('t.id', '=', row.id)
        .executeTakeFirstOrThrow();
      return toTier(tier);
    });
  }
}

/** 日期列按 YYYY-MM-DD 取出，不经过 JS Date，避免时区把日期挪一天 */
function isoDate<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  column: Parameters<ExpressionBuilder<DB, TB>['ref']>[0],
) {
  return eb.fn<string>('to_char', [eb.ref(column), eb.val('YYYY-MM-DD')]);
}

function historyColumns(eb: ExpressionBuilder<Database, 'client_health_history'>) {
  return [
    'id',
    'category',
    'content',
    eb
      .fn<string | null>('to_char', [eb.ref('recorded_on'), eb.val('YYYY-MM-DD')])
      .as('recorded_on_text'),
    'created_at',
    'updated_at',
  ] as const;
}

function selectHistory(trx: TenantTransaction, clientId: string) {
  return trx
    .selectFrom('client_health_history')
    .select(historyColumns)
    .where('client_id', '=', clientId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(HISTORY_LIMIT);
}

function toHistoryItem(row: {
  id: string;
  category: HealthHistoryItem['category'];
  content: string;
  recorded_on_text: string | null;
  created_at: Date;
  updated_at: Date;
}): HealthHistoryItem {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    recordedOn: row.recorded_on_text,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 分层历史从新到旧。设定人的姓名只在当前账号看得到那位用户时才有 */
function selectTiers(trx: TenantTransaction, clientId: string) {
  return trx
    .selectFrom('client_risk_tiers as t')
    .leftJoin('users as u', 'u.id', 't.set_by')
    .select(['t.id', 't.tier', 't.reason', 't.set_by', 't.set_at', 'u.display_name as set_by_name'])
    .where('t.client_id', '=', clientId)
    .orderBy('t.set_at', 'desc')
    .orderBy('t.id', 'desc');
}

function toTier(row: {
  id: string;
  tier: RiskTierRecord['tier'];
  reason: string;
  set_by: string;
  set_at: Date;
  set_by_name: string | null;
}): RiskTierRecord {
  return {
    id: row.id,
    tier: row.tier,
    reason: row.reason,
    setBy: row.set_by,
    setByName: row.set_by_name,
    setAt: row.set_at.toISOString(),
  };
}

async function clientVisible(trx: TenantTransaction, clientId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .executeTakeFirst();
  return Boolean(row);
}

/** 只有服务这位客户的健管师能写档案。锁住客户行，和并发的转出串行 */
async function ownClient(
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
