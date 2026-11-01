import { z } from 'zod';

/**
 * 运营看板（M7 规格 2.6）：只有汇总数字，没有客户 id、姓名、健管师写的文字和健康数值。
 * 协会管理员看本协会（按机构分组），平台看全部（可按协会筛选，另有到期提醒和估算成本），
 * 机构管理员看本机构。少于 5 人的机构合并为“其他”（Q15）；成本只给平台（Q14）。
 */

export const OPS_DASHBOARD_DAYS = [7, 30, 90] as const;
/** 小样本保护：健管师或客户少于这个数的机构合并为“其他”（Q15） */
export const SMALL_GROUP_MIN = 5;

export const opsDashboardQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .refine((v) => (OPS_DASHBOARD_DAYS as readonly number[]).includes(v))
      .default(30),
    operatorId: z.uuid().optional(),
  })
  .strict();
export type OpsDashboardQuery = z.infer<typeof opsDashboardQuerySchema>;

export const OPS_METRICS = [
  'managers_opened',
  'managers_active',
  'managers_engaged',
  'clients_total',
  'clients_new',
  'artifacts',
  'expert_calls',
  'care_plans',
  'visits_done',
  'companion_bound',
  'companion_active',
  'llm_calls',
] as const;
export type OpsMetric = (typeof OPS_METRICS)[number];

export const opsMetricsSchema = z.object(
  Object.fromEntries(OPS_METRICS.map((k) => [k, z.number().int().nonnegative()])) as Record<
    OpsMetric,
    z.ZodNumber
  >,
);
export type OpsMetrics = z.infer<typeof opsMetricsSchema>;

/** 一组的数字；costUsd 只有平台能看到，其他为 null */
export const opsRowSchema = z.object({
  metrics: opsMetricsSchema,
  costUsd: z.number().nonnegative().nullable(),
});

export const opsGroupSchema = opsRowSchema.extend({
  /** 机构：org 为具体机构，none 为不属于任何机构，other 为小样本合并后的“其他” */
  kind: z.enum(['org', 'none', 'other']),
  orgId: z.uuid().nullable(),
  name: z.string().nullable(),
  /** 合并后“其他”仍不足 5 人时，数字不显示（metrics 全为 0、hidden 为 true） */
  hidden: z.boolean(),
});
export type OpsGroup = z.infer<typeof opsGroupSchema>;

export const opsOperatorSchema = opsRowSchema.extend({
  operatorId: z.uuid(),
  name: z.string(),
  contractEnd: z.iso.date().nullable(),
  expiringSoon: z.boolean(),
  expired: z.boolean(),
  seatLimit: z.number().int(),
});
export type OpsOperator = z.infer<typeof opsOperatorSchema>;

export const opsDashboardResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  totals: opsRowSchema,
  groups: z.array(opsGroupSchema),
  /** 技能产物数：技能 id、标题（技能目录里的产物标题）和次数 */
  skills: z.array(z.object({ skillId: z.string(), title: z.string(), n: z.number().int() })),
  /** 孪生打开次数（协会粒度；机构管理员查看时为 null） */
  twinOpens: z.number().int().nullable(),
  /** 席位（看单个协会时有） */
  seats: z.object({ used: z.number().int(), limit: z.number().int() }).nullable(),
  /** 平台看全部时每个协会一行 */
  operators: z.array(opsOperatorSchema).nullable(),
});
export type OpsDashboardResponse = z.infer<typeof opsDashboardResponseSchema>;

export function emptyMetrics(): OpsMetrics {
  return Object.fromEntries(OPS_METRICS.map((k) => [k, 0])) as OpsMetrics;
}

export function addMetrics(a: OpsMetrics, b: OpsMetrics): OpsMetrics {
  return Object.fromEntries(OPS_METRICS.map((k) => [k, a[k] + b[k]])) as OpsMetrics;
}

/**
 * 小样本保护（Q15 A）：已激活的健管师或客户少于 5 的机构合并为“其他”。
 * 下面几种情况数字不显示（hidden），防止推出单个机构或个人：
 * - “其他”合并后健管师或客户仍少于 5；
 * - “其他”只合并了一个机构（协会管理员知道机构名单，缺了谁就是谁）；
 * - 有一组被隐藏时，合计减可见各行就能算出它：再把可见组里最小的一组一起隐藏（二次隐藏，合规审查 B2）。
 * 合计照常显示（Q15 A）。
 */
export function protectSmallGroups(
  groups: {
    kind: 'org' | 'none';
    orgId: string | null;
    name: string | null;
    metrics: OpsMetrics;
    costUsd: number | null;
  }[],
): OpsGroup[] {
  // 按已激活的健管师算：待激活的邀请协会管理员自己就能开，不能用来撑过门槛（租户审查 S1）
  const small = (m: OpsMetrics) =>
    m.managers_active < SMALL_GROUP_MIN || m.clients_total < SMALL_GROUP_MIN;
  const kept: OpsGroup[] = [];
  let other: { metrics: OpsMetrics; costUsd: number | null; members: number } | null = null;
  for (const g of groups) {
    if (!small(g.metrics)) {
      kept.push({ ...g, hidden: false });
      continue;
    }
    other = other
      ? {
          metrics: addMetrics(other.metrics, g.metrics),
          costUsd: other.costUsd === null || g.costUsd === null ? null : other.costUsd + g.costUsd,
          members: other.members + 1,
        }
      : { metrics: g.metrics, costUsd: g.costUsd, members: 1 };
  }
  const hideRow = (g: OpsGroup): OpsGroup => ({
    ...g,
    hidden: true,
    metrics: emptyMetrics(),
    costUsd: null,
  });
  if (other) {
    const hidden = other.members < 2 || small(other.metrics);
    const row: OpsGroup = {
      kind: 'other',
      orgId: null,
      name: null,
      hidden: false,
      metrics: other.metrics,
      costUsd: other.costUsd,
    };
    if (!hidden) kept.push(row);
    else {
      // 二次隐藏：可见组里健管师最少的一组也不显示数字，合计减可见行得不出被隐藏的组
      if (kept.length > 0) {
        let min = 0;
        kept.forEach((g, i) => {
          if (g.metrics.managers_active < kept[min]!.metrics.managers_active) min = i;
        });
        kept[min] = hideRow(kept[min]!);
      }
      kept.push(hideRow(row));
    }
  }
  return kept;
}
