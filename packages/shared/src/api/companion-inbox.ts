import { z } from 'zod';
import { COMPANION_ALERT_CATEGORIES, COMPANION_HANDOFF_CATEGORIES } from './companion.js';
import { checkinMetricSchema } from './companion-checkins.js';

/**
 * 健管师处理福宝的转交、预警、待确认的测量，查看收集信息、聊天和记忆（M6 规格 2.4、2.5、2.7、2.8、
 * N10、N13、N14、N18）。只给服务这位客户的健管师；机构管理员、运营商、平台看不到明细（Q28）。
 */

// ---------- 转交（规格 2.4、N13、N14） ----------

export const COMPANION_HANDOFF_STATUSES = [
  'open',
  'replied',
  'delivered',
  'closed_by_call',
  'closed',
] as const;
export const companionHandoffStatusSchema = z.enum(COMPANION_HANDOFF_STATUSES);
export type CompanionHandoffStatus = z.infer<typeof companionHandoffStatusSchema>;

/** 转交 48 小时没有处理，在今日跟进里标“已超时”（N14） */
export const COMPANION_HANDOFF_OVERDUE_MS = 48 * 3600 * 1000;

/** 回复是念给老人听的：短句、口语，不超过 150 字（规格 2.9） */
export const COMPANION_REPLY_MAX = 150;

export const companionHandoffSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  clientName: z.string(),
  category: z.enum(COMPANION_HANDOFF_CATEGORIES),
  /** 客户的原话（识别出的文字，已去掉电话、证件号） */
  question: z.string(),
  status: companionHandoffStatusSchema,
  replyText: z.string().nullable(),
  repliedAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** 未处理且超过 48 小时 */
  overdue: z.boolean(),
});
export type CompanionHandoff = z.infer<typeof companionHandoffSchema>;

export const replyHandoffRequestSchema = z.object({
  text: z.string().trim().min(1).max(COMPANION_REPLY_MAX),
  /**
   * 回复会被福宝原样念给客户：含药名、用药建议、病名、数值评价、功效承诺等时先返回提醒
   * （400 invalid_content，reasons 第一项是 needs_confirmation，后面是提醒的类别），健管师看过提醒仍要发送时再带 true 提交（合规审查 S2）
   */
  acknowledgeWarnings: z.boolean().default(false),
});
export type ReplyHandoffRequest = z.infer<typeof replyHandoffRequestSchema>;

/** 已电话联系（closed_by_call）或直接关闭（closed） */
export const closeHandoffRequestSchema = z.object({
  outcome: z.enum(['closed_by_call', 'closed']),
});
export type CloseHandoffRequest = z.infer<typeof closeHandoffRequestSchema>;

// ---------- 预警（规格 2.5） ----------

export const COMPANION_ALERT_RESOLUTIONS = [
  'called',
  'contacted_family',
  'seen_doctor',
  'other',
] as const;
export const alertResolutionSchema = z.enum(COMPANION_ALERT_RESOLUTIONS);
export type AlertResolution = z.infer<typeof alertResolutionSchema>;

export const COMPANION_ALERT_NOTE_MAX = 500;

export const companionAlertSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  clientName: z.string(),
  category: z.enum(COMPANION_ALERT_CATEGORIES),
  trigger: z.enum(['keyword', 'model', 'threshold']),
  /** 触发的那句客户原话（危急指标预警没有原话时为空） */
  said: z.string().nullable(),
  /** 福宝当时说了什么（固定话术的文字） */
  companionSaid: z.string().nullable(),
  status: z.enum(['open', 'handled']),
  resolution: alertResolutionSchema.nullable(),
  note: z.string().nullable(),
  handledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CompanionAlert = z.infer<typeof companionAlertSchema>;

/** 处理方式必填；“其他”时备注必填 */
export const handleAlertRequestSchema = z
  .object({
    resolution: alertResolutionSchema,
    note: z
      .string()
      .trim()
      .max(COMPANION_ALERT_NOTE_MAX)
      .transform((s) => s || null)
      .nullable()
      .default(null),
  })
  .refine((v) => v.resolution !== 'other' || v.note !== null, {
    message: 'note required for other',
    path: ['note'],
  });
export type HandleAlertRequest = z.infer<typeof handleAlertRequestSchema>;

// ---------- 收集信息（规格 2.7） ----------

export const COMPANION_OBSERVATION_CATEGORIES = [
  'diet',
  'sleep',
  'exercise',
  'mood',
  'adherence',
  'body',
  'life',
  'measurement',
] as const;
export const observationCategorySchema = z.enum(COMPANION_OBSERVATION_CATEGORIES);
export type ObservationCategory = z.infer<typeof observationCategorySchema>;

export const companionObservationSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  category: observationCategorySchema,
  polarity: z.enum(['negative', 'neutral', 'positive']).nullable(),
  text: z.string(),
  observedOn: z.iso.date(),
  metric: checkinMetricSchema.nullable(),
  values: z.array(z.number()),
  status: z.enum(['info', 'pending_confirm', 'confirmed', 'dismissed']),
  createdAt: z.iso.datetime(),
});
export type CompanionObservation = z.infer<typeof companionObservationSchema>;
export const companionObservationListResponseSchema = z.object({
  observations: z.array(companionObservationSchema),
});
export type CompanionObservationListResponse = z.infer<
  typeof companionObservationListResponseSchema
>;

// ---------- 聊天和记忆（N10） ----------

export const companionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['client', 'companion']),
  /** chat：客户说的、福宝的回答；script：固定话术；handoff_reply：健管师的回复（福宝念） */
  kind: z.enum(['chat', 'script', 'handoff_reply']),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type CompanionMessage = z.infer<typeof companionMessageSchema>;

export const companionSessionSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  summary: z.string().nullable(),
  messages: z.array(companionMessageSchema),
});
export type CompanionSession = z.infer<typeof companionSessionSchema>;

/** 每页会话数 */
export const COMPANION_SESSIONS_PAGE = 10;

export const companionSessionListResponseSchema = z.object({
  sessions: z.array(companionSessionSchema),
  /** 下一页的游标（更早的会话）；没有更多时为 null */
  next: z.string().nullable(),
});
export type CompanionSessionListResponse = z.infer<typeof companionSessionListResponseSchema>;

export const companionMemorySchema = z.object({
  id: z.uuid(),
  text: z.string(),
  createdAt: z.iso.datetime(),
});
export type CompanionMemory = z.infer<typeof companionMemorySchema>;
export const companionMemoryListResponseSchema = z.object({
  memories: z.array(companionMemorySchema),
});
export type CompanionMemoryListResponse = z.infer<typeof companionMemoryListResponseSchema>;

// ---------- 今日跟进“伴侣”分组（规格 2.8、Q24、N18） ----------

/** 设备离线超过这么久，今日跟进出现“设备离线”提醒（N18） */
export const COMPANION_OFFLINE_REMIND_MS = 24 * 3600 * 1000;

export const companionInboxResponseSchema = z.object({
  /** 未处理的预警（置顶） */
  alerts: z.array(companionAlertSchema),
  /** 未处理的转交（open），超时的在前 */
  handoffs: z.array(companionHandoffSchema),
  /** 待确认的测量 */
  pendingReadings: z.array(companionObservationSchema.extend({ clientName: z.string() })),
  /** 离线超过 24 小时、还没点“知道了”的设备 */
  offlineDevices: z.array(
    z.object({
      clientId: z.uuid(),
      clientName: z.string(),
      lastSeenAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type CompanionInboxResponse = z.infer<typeof companionInboxResponseSchema>;

/** 某位客户的预警和转交（伴侣视图，含已处理的） */
export const clientCompanionCasesResponseSchema = z.object({
  alerts: z.array(companionAlertSchema),
  handoffs: z.array(companionHandoffSchema),
});
export type ClientCompanionCasesResponse = z.infer<typeof clientCompanionCasesResponseSchema>;
