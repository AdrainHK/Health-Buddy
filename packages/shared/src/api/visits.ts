import { z } from 'zod';
import {
  visitFrequencyRulesSchema,
  visitMethodSchema,
  visitPurposeSchema,
} from '../plan/visit-schedule.js';
import { timeZoneSchema } from './follow-ups.js';

/**
 * 随访（M5 规格 2.7–2.9、6.3）：随访日程、今日随访、随访素材和随访记录。
 * 只给服务这位客户的健管师看；机构管理员、运营商、平台都看不到明细（Q28）。
 * 素材原文和记录内容不进日志、错误信息和埋点。
 */

export const VISIT_STATUSES = [
  'planned',
  'done',
  'missed',
  'cancelled',
  'superseded',
  'pending_plan',
] as const;
export const visitStatusSchema = z.enum(VISIT_STATUSES);
export type VisitStatus = z.infer<typeof visitStatusSchema>;

/** 随访的来历：随访计划排出、方案生效时自动排的复评、健管师手动加 */
export const VISIT_ORIGINS = ['schedule', 'plan_review', 'manual'] as const;
export const visitOriginSchema = z.enum(VISIT_ORIGINS);

/** 取消的原因：客户暂停服务、已在其他渠道联系、重复、其他 */
export const VISIT_CANCEL_REASONS = [
  'client_paused',
  'contacted_elsewhere',
  'duplicate',
  'other',
] as const;
export const visitCancelReasonSchema = z.enum(VISIT_CANCEL_REASONS);

export const VISIT_FOCUS_MAX = 200;
export const VISIT_NOTE_MAX = 500;
/** 未联系上时默认顺延 2 天（可改） */
export const VISIT_MISSED_POSTPONE_DAYS = 2;

export const visitSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  dueDate: z.iso.date(),
  method: visitMethodSchema,
  purpose: visitPurposeSchema,
  focus: z.string().nullable(),
  origin: visitOriginSchema,
  status: visitStatusSchema,
  cancelReason: visitCancelReasonSchema.nullable(),
  note: z.string().nullable(),
  carePlanId: z.uuid().nullable(),
  followUpItemId: z.uuid().nullable(),
  recordId: z.uuid().nullable(),
  rescheduledFrom: z.iso.date().nullable(),
  doneAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Visit = z.infer<typeof visitSchema>;

/** 随访计划草稿的一行（artifacts.structured，kind = visit_schedule） */
export const visitScheduleRowSchema = z.object({
  dueDate: z.iso.date(),
  method: visitMethodSchema,
  purpose: visitPurposeSchema.exclude(['adhoc']),
  focus: z.string().trim().max(VISIT_FOCUS_MAX).nullable(),
});
export type VisitScheduleRow = z.infer<typeof visitScheduleRowSchema>;

export const VISIT_SCHEDULE_ROWS_MAX = 30;

/** 日期由后端算（Q17），草稿里可以改；日期不能重复，后端再校验不早于今天、不超过 6 个月后 */
export const visitScheduleStructuredSchema = z.object({
  rows: z
    .array(visitScheduleRowSchema)
    .min(1)
    .max(VISIT_SCHEDULE_ROWS_MAX)
    .refine((v) => new Set(v.map((r) => r.dueDate)).size === v.length, {
      message: 'duplicate date',
    }),
});
export type VisitScheduleStructured = z.infer<typeof visitScheduleStructuredSchema>;

export const visitListQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: visitStatusSchema.optional(),
  clientId: z.uuid().optional(),
});
export type VisitListQuery = z.infer<typeof visitListQuerySchema>;

export const visitListResponseSchema = z.object({ visits: z.array(visitSchema) });
export type VisitListResponse = z.infer<typeof visitListResponseSchema>;

export const todayVisitsQuerySchema = z.object({
  /** 账号没有设置时区时用浏览器时区（同 M4 Q13） */
  tz: timeZoneSchema.optional(),
});

/** 今日随访（2.7，Q19）：今天到期和逾期未处理的随访 */
export const todayVisitsResponseSchema = z.object({
  /** 排序：逾期天数从多到少 → 方案复评和跟进项回访在前 → 时间 */
  items: z.array(
    visitSchema.extend({
      /** 客户称呼，只在工作台显示 */
      clientName: z.string(),
      overdueDays: z.number().int().nonnegative(),
    }),
  ),
  count: z.number().int().nonnegative(),
  date: z.iso.date(),
  timeZone: z.string(),
});
export type TodayVisitsResponse = z.infer<typeof todayVisitsResponseSchema>;

/** 加一次随访（2.7）：可以从跟进项发起 */
export const createVisitRequestSchema = z.object({
  dueDate: z.iso.date(),
  method: visitMethodSchema,
  purpose: visitPurposeSchema.exclude(['plan_review']).default('adhoc'),
  focus: z.string().trim().max(VISIT_FOCUS_MAX).optional(),
  followUpItemId: z.uuid().optional(),
});
export type CreateVisitRequest = z.infer<typeof createVisitRequestSchema>;

const noteField = z.string().trim().min(1).max(VISIT_NOTE_MAX);

/** 处理随访：完成（关联记录或写备注，Q26）、未联系上、改期、取消（必须选原因） */
export const updateVisitRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('done'),
      recordId: z.uuid().optional(),
      /** 选“不记录”时写一句备注 */
      note: noteField.optional(),
    })
    .refine((v) => v.recordId !== undefined || v.note !== undefined, {
      message: 'done needs a record or a note',
    }),
  z.object({
    action: z.literal('missed'),
    /** 新的日期，缺省为 2 天后 */
    newDate: z.iso.date().optional(),
  }),
  z.object({ action: z.literal('reschedule'), newDate: z.iso.date() }),
  z.object({
    action: z.literal('cancel'),
    cancelReason: visitCancelReasonSchema,
    note: noteField.optional(),
  }),
]);
export type UpdateVisitRequest = z.infer<typeof updateVisitRequestSchema>;

export const visitResponseSchema = z.object({ visit: visitSchema });

// ---------- 随访素材（2.9，Q21、Q23、Q24） ----------

export const VISIT_MATERIAL_TEXT_MAX = 20000;
/** 一次 /随访记录 最多引用 3 份素材 */
export const VISIT_MATERIALS_PER_RECORD_MAX = 3;
/** 每位健管师每天最多上传 100 份（Q31） */
export const VISIT_MATERIALS_DAILY_MAX = 100;
/** 素材原文保留天数（Q23） */
export const VISIT_MATERIAL_RETENTION_DAYS = 30;

/** 素材来源：粘贴、本地读出的 .txt、聊天截图转写（健管师核对后上传） */
export const VISIT_MATERIAL_SOURCES = ['paste', 'txt', 'screenshot'] as const;
export type VisitMaterialSource = (typeof VISIT_MATERIAL_SOURCES)[number];

/** 聊天截图：一次最多 9 张，单张不超过 20 MB（同报告原件），原图不保存 */
export const CHAT_SCREENSHOT_LIMITS = { maxFiles: 9, maxFileBytes: 20 * 1024 * 1024 } as const;

/**
 * 截图转写的结果（POST /api/clients/:id/visit-materials/transcribe）：只返回文字，不保存任何东西；
 * 健管师核对、修改后再用 source = screenshot 上传
 */
export const chatTranscriptionResponseSchema = z.object({
  text: z.string(),
  imageCount: z.number().int().positive(),
});
export type ChatTranscriptionResponse = z.infer<typeof chatTranscriptionResponseSchema>;

/** 转写失败的原因（422 transcription_failed） */
export const CHAT_TRANSCRIPTION_FAILURES = [
  'not_a_chat',
  'unreadable',
  'refused',
  'timeout',
  'error',
] as const;
export type ChatTranscriptionFailure = (typeof CHAT_TRANSCRIPTION_FAILURES)[number];

/** 素材列表项：不含原文 */
export const visitMaterialSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  visitId: z.uuid().nullable(),
  kind: z.enum(VISIT_MATERIAL_SOURCES),
  charCount: z.number().int().nonnegative(),
  /** 已整理成记录的那份产物 */
  consumedArtifactId: z.uuid().nullable(),
  /** 原文到期删除的时间 */
  purgeAfter: z.iso.datetime(),
  /** 原文已删除 */
  purged: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type VisitMaterial = z.infer<typeof visitMaterialSchema>;

/**
 * 上传素材：粘贴的文字，工作台在本地读出的 .txt 文件内容（source = txt；后端不解析文件），
 * 或健管师核对过的截图转写文字（source = screenshot）
 */
export const createVisitMaterialRequestSchema = z.object({
  text: z.string().trim().min(1).max(VISIT_MATERIAL_TEXT_MAX),
  source: z.enum(VISIT_MATERIAL_SOURCES).default('paste'),
  visitId: z.uuid().optional(),
  /** 第一次为这位客户上传时必须为 true（已告知客户，Q24）；以后不再询问 */
  consentConfirmed: z.boolean().optional(),
});
export type CreateVisitMaterialRequest = z.input<typeof createVisitMaterialRequestSchema>;

export const visitMaterialResponseSchema = z.object({ material: visitMaterialSchema });

/** 第一次为这位客户上传素材却没勾选“已告知客户”时，400 的原因 */
export const VISIT_MATERIAL_CONSENT_REQUIRED = 'consent_required';

export const visitMaterialListResponseSchema = z.object({
  materials: z.array(visitMaterialSchema),
  /** 是否已有“已告知客户”的记录 */
  consentRecorded: z.boolean(),
});
export type VisitMaterialListResponse = z.infer<typeof visitMaterialListResponseSchema>;

// ---------- 随访记录（2.9） ----------

const shortText = z.string().trim().max(1000);
const textList = z.array(z.string().trim().min(1).max(500)).max(20);

/** 客户反馈的分组：饮食、运动、作息、心理和情绪、身体不适、用药情况、其他 */
export const VISIT_FEEDBACK_TOPICS = [
  'diet',
  'exercise',
  'routine',
  'mood',
  'discomfort',
  'medication',
  'other',
] as const;

/** 建议更新健康史的条目（Q25）：健管师逐条点“加入健康史”才写入 */
export const healthHistorySuggestionSchema = z.object({
  category: z.enum(['past_history', 'family_history', 'medication', 'allergy', 'lifestyle']),
  content: z.string().trim().min(1).max(500),
});

/** 随访记录草稿的结构化内容（artifacts.structured，kind = visit_record），只有专业版 */
export const visitRecordStructuredSchema = z.object({
  /** 随访日期、方式：不确定时为空，由健管师确认前填写 */
  visitDate: z.iso.date().nullable(),
  method: visitMethodSchema.nullable(),
  summary: shortText,
  /** 只写客户说了什么，不评价 */
  feedback: z.array(z.object({ topic: z.enum(VISIT_FEEDBACK_TOPICS), items: textList })).max(7),
  planProgress: textList,
  agreements: textList,
  attentionPoints: textList,
  historySuggestions: z.array(healthHistorySuggestionSchema).max(10),
  /** 素材里没有、但下次随访要了解的情况 */
  openQuestions: textList,
});
export type VisitRecordStructured = z.infer<typeof visitRecordStructuredSchema>;

export const visitRecordSummarySchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  visitId: z.uuid().nullable(),
  visitDate: z.iso.date(),
  method: visitMethodSchema,
  /** 摘要的前 50 个字（时间轴用） */
  excerpt: z.string(),
  approvedAt: z.iso.datetime(),
});
export type VisitRecordSummary = z.infer<typeof visitRecordSummarySchema>;

export const visitRecordAddendumSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  createdAt: z.iso.datetime(),
});

export const visitRecordSchema = visitRecordSummarySchema.extend({
  snapshot: visitRecordStructuredSchema,
  addenda: z.array(visitRecordAddendumSchema),
});
export type VisitRecord = z.infer<typeof visitRecordSchema>;

export const visitRecordListResponseSchema = z.object({
  records: z.array(visitRecordSummarySchema),
});
export type VisitRecordListResponse = z.infer<typeof visitRecordListResponseSchema>;

export const visitRecordResponseSchema = z.object({ record: visitRecordSchema });
export type VisitRecordResponse = z.infer<typeof visitRecordResponseSchema>;

export const VISIT_ADDENDUM_MAX = 1000;
/** 补充说明（只追加，记录确认后不能修改） */
export const createAddendumRequestSchema = z.object({
  text: z.string().trim().min(1).max(VISIT_ADDENDUM_MAX),
});
export type CreateAddendumRequest = z.infer<typeof createAddendumRequestSchema>;

// ---------- 随访频次规则（Q18） ----------

export const visitFrequencyRulesResponseSchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  rules: visitFrequencyRulesSchema,
});
export type VisitFrequencyRulesResponse = z.infer<typeof visitFrequencyRulesResponseSchema>;

/** 平台管理员修改（PATCH /api/admin/visit-frequency-rules）：整套替换 */
export const updateVisitFrequencyRulesRequestSchema = visitFrequencyRulesSchema;

/**
 * 随访频次规则的修改记录（只有平台管理员能看）。target 是改的哪一行：一个风险分层，或
 * “有 1、2 级未处理跟进项时首次随访不晚于几天”（first_visit）。规则不是客户数据，可以记原值。
 */
export const visitFrequencyRuleEventSchema = z.object({
  id: z.string(),
  target: z.enum(['high', 'medium', 'low', 'none', 'first_visit']),
  actorName: z.string().nullable(),
  rulesVersion: z.number().int().positive(),
  before: z.object({
    intervalDays: z.number().int().optional(),
    defaultMethod: visitMethodSchema.optional(),
    firstVisitWithinDays: z.number().int().optional(),
  }),
  after: z.object({
    intervalDays: z.number().int().optional(),
    defaultMethod: visitMethodSchema.optional(),
    firstVisitWithinDays: z.number().int().optional(),
  }),
  createdAt: z.iso.datetime(),
});
export type VisitFrequencyRuleEvent = z.infer<typeof visitFrequencyRuleEventSchema>;
export const visitFrequencyRuleEventListResponseSchema = z.object({
  events: z.array(visitFrequencyRuleEventSchema),
});
export type VisitFrequencyRuleEventListResponse = z.infer<
  typeof visitFrequencyRuleEventListResponseSchema
>;
