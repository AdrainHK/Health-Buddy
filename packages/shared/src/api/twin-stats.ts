import { z } from 'zod';

/**
 * 孪生统计（M4 规格 7.2 统计视图、7.4 GET /api/twin-stats）：运营商看本协会，平台看全部。
 * 只有按协会、日期（UTC 自然日）汇总的数字，不含健管师、客户的 id。
 */
export const TWIN_STATS_DEFAULT_DAYS = 30;
export const TWIN_STATS_MAX_DAYS = 366;

export const twinStatsQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** 只对平台管理员生效：按协会筛选。运营商传了也只返回本协会 */
    operatorId: z.uuid().optional(),
  })
  .strict();
export type TwinStatsQuery = z.infer<typeof twinStatsQuerySchema>;

const countsShape = {
  /** 孪生打开次数（健管师和机构管理员） */
  opens: z.number().int().nonnegative(),
  /** 新生成的跟进项 */
  followUpsCreated: z.number().int().nonnegative(),
  /** 各处理方式的次数 */
  done: z.number().int().nonnegative(),
  snoozed: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  reopened: z.number().int().nonnegative(),
  /** /孪生小结 生成次数 */
  summaries: z.number().int().nonnegative(),
};

export const twinUsageStatsSchema = z.object({
  /** 只在平台管理员的结果里出现；运营商看到的都是本协会，为 null */
  operatorId: z.uuid().nullable(),
  operatorName: z.string().nullable(),
  date: z.iso.date(),
  ...countsShape,
});
export type TwinUsageStats = z.infer<typeof twinUsageStatsSchema>;

export const twinStatsResponseSchema = z.object({
  scope: z.enum(['platform', 'operator']),
  from: z.iso.date(),
  to: z.iso.date(),
  operatorId: z.uuid().nullable(),
  operators: z.array(z.object({ id: z.uuid(), name: z.string() })),
  rows: z.array(twinUsageStatsSchema),
  totals: z.object(countsShape),
});
export type TwinStatsResponse = z.infer<typeof twinStatsResponseSchema>;
