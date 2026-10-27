import { z } from 'zod';

/**
 * 方案和随访统计（M5 规格 6.2 统计视图、6.4 GET /api/plan-stats）：运营商看本协会，平台看全部；
 * 健管师、机构管理员 403。只有按协会、日期（UTC 自然日）汇总的数字，不含健管师、客户的 id。
 */
export const PLAN_STATS_DEFAULT_DAYS = 30;
export const PLAN_STATS_MAX_DAYS = 366;

export const planStatsQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** 只对平台管理员生效：按协会筛选。运营商传了也只返回本协会 */
    operatorId: z.uuid().optional(),
  })
  .strict();
export type PlanStatsQuery = z.infer<typeof planStatsQuerySchema>;

const countsShape = {
  /** /方案生成 次数（每条方案产物链算一次） */
  plansGenerated: z.number().int().nonnegative(),
  /** 方案确认（生效）数 */
  plansApproved: z.number().int().nonnegative(),
  /** 随访计划确认数 */
  schedulesApproved: z.number().int().nonnegative(),
  /** 随访完成数、未联系上数 */
  visitsDone: z.number().int().nonnegative(),
  visitsMissed: z.number().int().nonnegative(),
  /** 随访记录确认数 */
  recordsApproved: z.number().int().nonnegative(),
};

export const planUsageStatsSchema = z.object({
  /** 只在平台管理员的结果里出现；运营商看到的都是本协会，为 null */
  operatorId: z.uuid().nullable(),
  operatorName: z.string().nullable(),
  date: z.iso.date(),
  ...countsShape,
});

export const planStatsResponseSchema = z.object({
  scope: z.enum(['platform', 'operator']),
  from: z.iso.date(),
  to: z.iso.date(),
  operatorId: z.uuid().nullable(),
  operators: z.array(z.object({ id: z.uuid(), name: z.string() })),
  rows: z.array(planUsageStatsSchema),
  totals: z.object(countsShape),
});
export type PlanStatsResponse = z.infer<typeof planStatsResponseSchema>;
