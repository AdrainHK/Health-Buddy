import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_TWIN_STATUS_RULES,
  twinRuleShapeError,
  type CreateTwinStatusRuleRequest,
  type IndicatorCode,
  type TwinRulesResponse,
  type TwinStatusRuleRecord,
  type UpdateTwinStatusRuleRequest,
} from '@health-buddy/shared';
import { badRequest, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import {
  twinStatusRulesReset,
  twinUsageStats,
  type TwinUsageStatsRow,
} from '../db/twin-functions.js';

/**
 * 孪生状态规则（M4 规格 2.10，Q1）：全平台一套。所有后台角色和健管师都能读，只有平台管理员能改
 * （行级安全是第二道防线）。修改记录和版本号由数据库触发器写入，这里不单独记。
 * 规则不是客户数据，可以记数值。
 */
@Injectable()
export class TwinRulesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(ctx: TenantContext): Promise<TwinRulesResponse> {
    return withTenant(this.db, ctx, (trx) => listIn(trx));
  }

  create(ctx: TenantContext, input: CreateTwinStatusRuleRequest): Promise<TwinStatusRuleRecord> {
    return this.write(ctx, async (trx) => {
      const row = await trx
        .insertInto('twin_status_rules')
        .values({
          domain: input.domain,
          metric: input.metric,
          source: input.source,
          method: input.method,
          comparator: input.comparator,
          value: input.value,
          unit: input.unit,
          window_days: input.windowDays,
          level: input.level,
          enabled: input.enabled,
          category: input.category,
          polarity: input.polarity,
          min_count: input.minCount,
          updated_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRule(row);
    });
  }

  /**
   * 方面、指标、来源、判断方式、类别和极性不能改；合并原规则后按同样的形状校验。找不到返回 undefined
   */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateTwinStatusRuleRequest,
  ): Promise<TwinStatusRuleRecord | undefined> {
    return this.write(ctx, async (trx) => {
      const current = await trx
        .selectFrom('twin_status_rules')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return undefined;
      const base = toRule(current);
      const merged = {
        ...base,
        comparator: input.comparator !== undefined ? input.comparator : base.comparator,
        value: input.value !== undefined ? input.value : base.value,
        unit: input.unit !== undefined ? input.unit : base.unit,
        windowDays: input.windowDays !== undefined ? input.windowDays : base.windowDays,
        level: input.level ?? base.level,
        enabled: input.enabled ?? base.enabled,
        minCount: input.minCount !== undefined ? input.minCount : base.minCount,
      };
      if (twinRuleShapeError(merged)) throw badRequest();
      const row = await trx
        .updateTable('twin_status_rules')
        .set({
          comparator: merged.comparator,
          value: merged.value,
          unit: merged.unit,
          window_days: merged.windowDays,
          level: merged.level,
          enabled: merged.enabled,
          min_count: merged.minCount,
          updated_by: ctx.userId,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row && toRule(row);
    });
  }

  /** 恢复为默认值（第五节之二）：由数据库函数整体替换，修改记录标为 reset，版本号只加一 */
  reset(ctx: TenantContext): Promise<TwinRulesResponse> {
    return this.write(ctx, async (trx) => {
      await twinStatusRulesReset(
        trx,
        DEFAULT_TWIN_STATUS_RULES.map((r) => ({
          domain: r.domain,
          metric: r.metric,
          source: r.source,
          method: r.method,
          comparator: r.comparator,
          value: r.value,
          unit: r.unit,
          window_days: r.windowDays,
          level: r.level,
          enabled: r.enabled ?? true,
          category: r.category ?? null,
          polarity: r.polarity ?? null,
          min_count: r.minCount ?? null,
        })),
      );
      return listIn(trx);
    });
  }

  /** 孪生统计：范围由数据库函数按租户上下文决定 */
  stats(
    ctx: TenantContext,
    range: { from: string; to: string; operatorId: string | null },
  ): Promise<TwinUsageStatsRow[]> {
    return withTenant(this.db, ctx, (trx) => twinUsageStats(trx, range));
  }

  /** 平台管理员筛选用的协会列表 */
  operators(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
    return withTenant(this.db, ctx, (trx) =>
      trx.selectFrom('operators').select(['id', 'name']).orderBy('name').execute(),
    );
  }

  /** 重复的规则 409；形状、范围不对（数据库 check 和触发器兜底）400 */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      const code = dbErrorCode(err);
      if (code === '23505') throw conflict();
      if (code === '23514' || code === '22023' || code === '22003') throw badRequest();
      throw err;
    }
  }
}

async function listIn(trx: TenantTransaction): Promise<TwinRulesResponse> {
  const rows = await trx
    .selectFrom('twin_status_rules')
    .selectAll()
    .orderBy('domain')
    .orderBy('source')
    .orderBy('metric')
    .orderBy('method')
    .orderBy('comparator')
    .execute();
  const version = await trx
    .selectFrom('twin_rules_version')
    .select(['version', 'updated_at'])
    .executeTakeFirst();
  return {
    version: version?.version ?? 0,
    updatedAt: (version?.updated_at ?? new Date(0)).toISOString(),
    rules: rows.map(toRule),
  };
}

function toRule(row: {
  id: string;
  domain: TwinStatusRuleRecord['domain'];
  metric: string | null;
  source: TwinStatusRuleRecord['source'];
  method: TwinStatusRuleRecord['method'];
  comparator: TwinStatusRuleRecord['comparator'];
  value: string | null;
  unit: string | null;
  window_days: number | null;
  level: TwinStatusRuleRecord['level'];
  enabled: boolean;
  category: TwinStatusRuleRecord['category'];
  polarity: TwinStatusRuleRecord['polarity'];
  min_count: number | null;
  updated_by: string | null;
  updated_at: Date;
}): TwinStatusRuleRecord {
  return {
    id: row.id,
    domain: row.domain,
    metric: row.metric as IndicatorCode | null,
    source: row.source,
    method: row.method,
    comparator: row.comparator,
    value: row.value === null ? null : Number(row.value),
    unit: row.unit,
    windowDays: row.window_days,
    level: row.level,
    enabled: row.enabled,
    category: row.category,
    polarity: row.polarity,
    minCount: row.min_count,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}
