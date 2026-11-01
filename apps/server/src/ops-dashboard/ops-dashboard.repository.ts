import { Inject, Injectable } from '@nestjs/common';
import {
  CONTRACT_EXPIRY_NOTICE_DAYS,
  OPS_METRICS,
  addMetrics,
  emptyMetrics,
  protectSmallGroups,
  type OpsDashboardResponse,
  type OpsMetrics,
} from '@health-buddy/shared';
import { getSkill } from '@health-buddy/skills';
import { DB } from '../db/db.provider.js';
import { opsDashboard, type OpsDashboardRaw } from '../db/ops-dashboard.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';

const DAY_MS = 86_400_000;

type GroupRow = OpsDashboardRaw['groups'][number];

function metricsOf(r: GroupRow): OpsMetrics {
  return Object.fromEntries(OPS_METRICS.map((k) => [k, Number(r[k] ?? 0)])) as OpsMetrics;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 运营看板（M7 规格 2.6）。数字只经数据库函数 ops_dashboard（范围由会话决定、只有汇总）；
 * 机构名、协会名按行级安全读；小样本合并（Q15）在这里做。
 */
@Injectable()
export class OpsDashboardRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  dashboard(
    ctx: TenantContext,
    days: number,
    operatorId: string | undefined,
  ): Promise<OpsDashboardResponse> {
    const now = new Date();
    const to = isoDay(now);
    const from = isoDay(new Date(now.getTime() - (days - 1) * DAY_MS));
    const platform = ctx.role === 'platform_admin';
    return withTenant(this.db, ctx, async (trx) => {
      const data = await opsDashboard(trx, from, to, platform ? (operatorId ?? null) : null);
      const cost = (r: GroupRow) => (platform ? Number(r.cost_usd ?? 0) : null);

      const orgIds = [...new Set(data.groups.map((g) => g.org_id).filter((x): x is string => !!x))];
      const orgNames = new Map(
        orgIds.length
          ? (
              await trx
                .selectFrom('organizations')
                .select(['id', 'name'])
                .where('id', 'in', orgIds)
                .execute()
            ).map((o) => [o.id, o.name])
          : [],
      );

      let totals = emptyMetrics();
      let totalCost = 0;
      for (const g of data.groups) {
        totals = addMetrics(totals, metricsOf(g));
        totalCost += Number(g.cost_usd ?? 0);
      }

      // 单个协会（运营商、机构管理员，或平台筛选了协会）：按机构分组；平台看全部：按协会一行
      const single = !platform || Boolean(operatorId);
      // 机构管理员只看本机构：卡片就是本机构的数，不再分组（合规审查 S2）
      const groups =
        single && ctx.role !== 'org_admin'
          ? protectSmallGroups(
              data.groups.map((g) => ({
                kind: g.org_id ? ('org' as const) : ('none' as const),
                orgId: g.org_id,
                name: g.org_id ? (orgNames.get(g.org_id) ?? null) : null,
                metrics: metricsOf(g),
                costUsd: cost(g),
              })),
            )
          : [];

      const operatorScope = platform ? operatorId : ctx.operatorId!;
      let seats: OpsDashboardResponse['seats'] = null;
      if (single && operatorScope && ctx.role !== 'org_admin') {
        const op = await trx
          .selectFrom('operators')
          .select('seat_limit')
          .where('id', '=', operatorScope)
          .executeTakeFirst();
        if (op) seats = { used: totals.managers_opened, limit: op.seat_limit };
      }

      let operators: OpsDashboardResponse['operators'] = null;
      if (platform && !operatorId) {
        const ops = await trx
          .selectFrom('operators')
          .select(['id', 'name', 'contract_end', 'seat_limit'])
          .orderBy('created_at')
          .execute();
        const notice = isoDay(new Date(now.getTime() + CONTRACT_EXPIRY_NOTICE_DAYS * DAY_MS));
        operators = ops.map((o) => {
          const mine = data.groups.filter((g) => g.operator_id === o.id);
          const end = o.contract_end ? isoDay(o.contract_end) : null;
          return {
            operatorId: o.id,
            name: o.name,
            contractEnd: end,
            expired: end !== null && end < to,
            expiringSoon: end !== null && end <= notice,
            seatLimit: o.seat_limit,
            metrics: mine.reduce((acc, g) => addMetrics(acc, metricsOf(g)), emptyMetrics()),
            costUsd: mine.reduce((acc, g) => acc + Number(g.cost_usd ?? 0), 0),
          };
        });
      }

      const skillCounts = new Map<string, number>();
      for (const s of data.skills) {
        skillCounts.set(s.skill_id, (skillCounts.get(s.skill_id) ?? 0) + Number(s.n));
      }
      return {
        from,
        to,
        totals: { metrics: totals, costUsd: platform ? totalCost : null },
        groups,
        skills: [...skillCounts]
          .map(([skillId, n]) => ({ skillId, title: getSkill(skillId)?.title ?? skillId, n }))
          .sort((a, b) => b.n - a.n),
        twinOpens:
          ctx.role === 'org_admin'
            ? null
            : data.twin_opens.reduce((acc, t) => acc + Number(t.n), 0),
        seats,
        operators,
      };
    });
  }
}
