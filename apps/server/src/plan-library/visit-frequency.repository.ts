import { Inject, Injectable } from '@nestjs/common';
import {
  VISIT_RISK_TIERS,
  type VisitFrequencyRuleEvent,
  type VisitFrequencyRules,
  type VisitFrequencyRulesResponse,
  type VisitMethod,
} from '@health-buddy/shared';
import { badRequest } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

/**
 * 随访频次规则（M5 规格第五节之二、2.12、Q18）：全平台一套。所有后台角色和健管师都能读，
 * 只有平台管理员能改（行级安全是第二道防线）。修改记录和版本号由数据库触发器写入（同一个事务只加一次）。
 * 改规则不改已经写入的随访日期，只影响以后生成的随访计划。规则不是客户数据，可以记数值。
 */
@Injectable()
export class VisitFrequencyRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(ctx: TenantContext): Promise<VisitFrequencyRulesResponse> {
    return withTenant(this.db, ctx, (trx) => getIn(trx));
  }

  /** 整套替换。分层固定四行；某一行没找到（不应发生）按请求不对处理 */
  update(ctx: TenantContext, rules: VisitFrequencyRules): Promise<VisitFrequencyRulesResponse> {
    return this.write(ctx, async (trx) => {
      for (const tier of VISIT_RISK_TIERS) {
        const r = rules.tiers[tier];
        const res = await trx
          .updateTable('visit_frequency_rules')
          .set({
            interval_days: r.intervalDays,
            default_method: r.defaultMethod,
            updated_by: ctx.userId,
          })
          .where('risk_tier', '=', tier)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw badRequest();
      }
      const res = await trx
        .updateTable('visit_frequency_config')
        .set({ first_visit_within_days: rules.firstVisitWithinDays, updated_by: ctx.userId })
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw badRequest();
      return getIn(trx);
    });
  }

  /** 修改记录（只有平台管理员能看，行级安全同样限制），新的在前 */
  events(ctx: TenantContext): Promise<VisitFrequencyRuleEvent[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('visit_frequency_rule_events as e')
        .leftJoin('users as u', 'u.id', 'e.actor_id')
        .select([
          'e.id',
          'e.before',
          'e.after',
          'e.rules_version',
          'e.created_at',
          'u.display_name',
        ])
        .orderBy('e.created_at', 'desc')
        .orderBy('e.id', 'desc')
        .limit(200)
        .execute();
      return rows.map((r) => {
        const before = (r.before ?? {}) as Record<string, unknown>;
        const after = (r.after ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id),
          target: (typeof after.risk_tier === 'string'
            ? after.risk_tier
            : 'first_visit') as VisitFrequencyRuleEvent['target'],
          actorName: r.display_name ?? null,
          rulesVersion: r.rules_version,
          before: ruleValues(before),
          after: ruleValues(after),
          createdAt: r.created_at.toISOString(),
        };
      });
    });
  }

  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      const code = dbErrorCode(err);
      if (code === '23514' || code === '22023') throw badRequest();
      throw err;
    }
  }
}

function ruleValues(row: Record<string, unknown>): VisitFrequencyRuleEvent['before'] {
  const out: VisitFrequencyRuleEvent['before'] = {};
  if (typeof row.interval_days === 'number') out.intervalDays = row.interval_days;
  if (typeof row.default_method === 'string') out.defaultMethod = row.default_method as VisitMethod;
  if (typeof row.first_visit_within_days === 'number') {
    out.firstVisitWithinDays = row.first_visit_within_days;
  }
  return out;
}

async function getIn(trx: TenantTransaction): Promise<VisitFrequencyRulesResponse> {
  const tiers = await trx.selectFrom('visit_frequency_rules').selectAll().execute();
  const config = await trx
    .selectFrom('visit_frequency_config')
    .select(['first_visit_within_days', 'updated_at'])
    .executeTakeFirst();
  const version = await trx
    .selectFrom('visit_frequency_version')
    .select(['version', 'updated_at'])
    .executeTakeFirst();
  const byTier = new Map(tiers.map((t) => [t.risk_tier, t]));
  const tier = (t: (typeof VISIT_RISK_TIERS)[number]) => {
    const row = byTier.get(t);
    if (!row) throw new Error('visit frequency rule missing');
    return { intervalDays: row.interval_days, defaultMethod: row.default_method };
  };
  if (!config) throw new Error('visit frequency config missing');
  return {
    version: version?.version ?? 1,
    updatedAt: (version?.updated_at ?? config.updated_at).toISOString(),
    rules: {
      tiers: { high: tier('high'), medium: tier('medium'), low: tier('low'), none: tier('none') },
      firstVisitWithinDays: config.first_visit_within_days,
    },
  };
}
