import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  PLAN_STATS_DEFAULT_DAYS,
  PLAN_STATS_MAX_DAYS,
  planStatsQuerySchema,
  type PlanStatsResponse,
} from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden, notFound } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db } from '../db/database.js';
import { planUsageStats } from '../db/plan-functions.js';
import type { Role } from '../db/types.js';

const READERS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 统计的日期范围（UTC 自然日，含首尾）。不传时默认最近 30 天，最长 366 天 */
function parseRange(query: unknown): { from: string; to: string; operatorId: string | null } {
  const parsed = planStatsQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw badRequest();
  const to = parsed.data.to ?? isoDay(new Date());
  const from =
    parsed.data.from ?? isoDay(new Date(Date.parse(to) - (PLAN_STATS_DEFAULT_DAYS - 1) * DAY_MS));
  for (const d of [from, to]) {
    const t = Date.parse(d);
    if (Number.isNaN(t) || isoDay(new Date(t)) !== d) throw badRequest();
  }
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span >= PLAN_STATS_MAX_DAYS) throw badRequest();
  return { from, to, operatorId: parsed.data.operatorId ?? null };
}

/**
 * 方案和随访统计（M5 规格 6.2、6.4 GET /api/plan-stats）：运营商看本协会，平台看全部；
 * 健管师、机构管理员 403。只有汇总数字，不含健管师、客户 id。
 */
@Controller('plan-stats')
export class PlanStatsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async stats(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<PlanStatsResponse> {
    if (!READERS.includes(session.role)) throw notFound();
    if (session.role !== 'platform_admin' && session.role !== 'operator_admin') throw forbidden();
    const platform = session.role === 'platform_admin';
    const range = parseRange(query);
    // 运营商传了别的协会也只返回本协会：这里不用它，数据库函数同样忽略
    const operatorId = platform ? range.operatorId : null;
    const { rows, operators } = await withTenant(this.db, session, async (trx) => ({
      rows: await planUsageStats(trx, { ...range, operatorId }),
      operators: platform
        ? await trx.selectFrom('operators').select(['id', 'name']).orderBy('name').execute()
        : [],
    }));
    const names = new Map(operators.map((o) => [o.id, o.name]));
    const totals = {
      plansGenerated: 0,
      plansApproved: 0,
      schedulesApproved: 0,
      visitsDone: 0,
      visitsMissed: 0,
      recordsApproved: 0,
    };
    for (const r of rows)
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
    return {
      scope: platform ? 'platform' : 'operator',
      from: range.from,
      to: range.to,
      operatorId,
      operators,
      rows: rows.map(({ operatorId: op, ...counts }) => ({
        ...counts,
        operatorId: platform ? op : null,
        operatorName: platform ? (names.get(op) ?? null) : null,
      })),
      totals,
    };
  }
}
