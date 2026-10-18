import { z } from 'zod';
import { twinDomainSchema } from './twin.js';

/**
 * 今日跟进清单（M4 规格 2.6，Q11–Q15）。
 * 跟进项全部由后端确定性生成，不经大模型；只在工作台里出现，不推送（Q28）。
 */

/** 危急指标、状态变红、状态变差（绿变黄）、偏离预测；“数据中断”M4 不做（Q14） */
export const FOLLOW_UP_KINDS = [
  'critical',
  'status_red',
  'status_worsened',
  'forecast_deviation',
] as const;
export const followUpKindSchema = z.enum(FOLLOW_UP_KINDS);
export type FollowUpKind = z.infer<typeof followUpKindSchema>;

/** 1 级最严重：危急 urgent → 1；危急 attention、状态变红 → 2；状态变差、偏离变差 → 3；偏离变好 → 4 */
export const FOLLOW_UP_SEVERITIES = [1, 2, 3, 4] as const;
export const followUpSeveritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type FollowUpSeverity = z.infer<typeof followUpSeveritySchema>;

/** 每种类型允许的严重程度（数据库 check 同样约束） */
export const FOLLOW_UP_KIND_SEVERITIES: Record<FollowUpKind, readonly FollowUpSeverity[]> = {
  critical: [1, 2],
  status_red: [2],
  status_worsened: [3],
  forecast_deviation: [3, 4],
};

export const FOLLOW_UP_STATUSES = ['open', 'done', 'snoozed', 'dismissed'] as const;
export const followUpStatusSchema = z.enum(FOLLOW_UP_STATUSES);
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

/** 已处理的方式：已电话联系、已安排复查、已建议就医、已调整方案、其他 */
export const FOLLOW_UP_RESOLUTIONS = [
  'called',
  'recheck_arranged',
  'referred',
  'plan_adjusted',
  'other',
] as const;
export const followUpResolutionSchema = z.enum(FOLLOW_UP_RESOLUTIONS);

/** 忽略的原因：数据误差、已知情况、客户已在就医、其他 */
export const FOLLOW_UP_DISMISS_REASONS = ['data_error', 'known', 'under_care', 'other'] as const;
export const followUpDismissReasonSchema = z.enum(FOLLOW_UP_DISMISS_REASONS);

/** 暂缓到明天、3 天后、7 天后 */
export const FOLLOW_UP_SNOOZE_DAYS = [1, 3, 7] as const;

export const FOLLOW_UP_NOTE_MAX = 500;

export const FOLLOW_UP_EVENT_ACTIONS = [
  'created',
  'retriggered',
  'done',
  'snoozed',
  'dismissed',
  'reopened',
  'consulted',
] as const;

export const followUpItemSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  /** 客户称呼，只在工作台显示 */
  clientName: z.string(),
  kind: followUpKindSchema,
  severity: followUpSeveritySchema,
  domain: twinDomainSchema.nullable(),
  metric: z.string().nullable(),
  /** 一句依据，由后端按模板生成（如“收缩压 182 mmHg（2026-10-17 监测）达到危急阈值 ≥ 180”的结构化数据） */
  basis: z.record(z.string(), z.unknown()),
  status: followUpStatusSchema,
  snoozeUntil: z.iso.datetime().nullable(),
  resolution: followUpResolutionSchema.nullable(),
  dismissReason: followUpDismissReasonSchema.nullable(),
  note: z.string().nullable(),
  firstTriggeredAt: z.iso.datetime(),
  lastTriggeredAt: z.iso.datetime(),
  /** 已延续几天（按健管师时区，Q13） */
  carriedDays: z.number().int().nonnegative(),
  /** 最近一次“请专家看看”的时间；不会因此自动标为已处理 */
  consultedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type FollowUpItem = z.infer<typeof followUpItemSchema>;

export const followUpListQuerySchema = z.object({
  /** 按健管师时区的日期（YYYY-MM-DD），缺省为今天 */
  date: z.iso.date().optional(),
  status: z.enum(['active', ...FOLLOW_UP_STATUSES]).default('active'),
  clientId: z.uuid().optional(),
});
export type FollowUpListQuery = z.infer<typeof followUpListQuerySchema>;

export const followUpListResponseSchema = z.object({
  /** 排序（Q15）：严重程度 1 级最先，同级按最近触发时间从新到旧 */
  items: z.array(followUpItemSchema),
  /** 未处理数量（左侧栏角标） */
  openCount: z.number().int().nonnegative(),
});
export type FollowUpListResponse = z.infer<typeof followUpListResponseSchema>;

const noteSchema = z.string().trim().max(FOLLOW_UP_NOTE_MAX).optional();

/** 处理跟进项。危急类不能忽略：后端拿到项目类型后再拒绝（400） */
export const updateFollowUpRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('done'),
    resolution: followUpResolutionSchema.optional(),
    note: noteSchema,
  }),
  z.object({
    action: z.literal('snooze'),
    snoozeDays: z.union([z.literal(1), z.literal(3), z.literal(7)]),
    note: noteSchema,
  }),
  z.object({
    action: z.literal('dismiss'),
    dismissReason: followUpDismissReasonSchema,
    note: noteSchema,
  }),
  z.object({ action: z.literal('reopen') }),
]);
export type UpdateFollowUpRequest = z.infer<typeof updateFollowUpRequestSchema>;

export const followUpItemResponseSchema = z.object({ item: followUpItemSchema });
export type FollowUpItemResponse = z.infer<typeof followUpItemResponseSchema>;

/** 排序（Q15）：严重程度 → 同级按最近触发时间从新到旧 */
export function compareFollowUps(
  a: Pick<FollowUpItem, 'severity' | 'lastTriggeredAt' | 'id'>,
  b: Pick<FollowUpItem, 'severity' | 'lastTriggeredAt' | 'id'>,
): number {
  return (
    a.severity - b.severity ||
    Date.parse(b.lastTriggeredAt) - Date.parse(a.lastTriggeredAt) ||
    a.id.localeCompare(b.id)
  );
}
