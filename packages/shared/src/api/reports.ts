import { z } from 'zod';
import { ABNORMAL_FLAGS } from '../health/reference.js';
import { criticalFlagSchema } from './artifacts.js';
import { reportSourceSchema } from './client-record.js';

/**
 * 报告上传、识别和核对（M2 规格 2.3、2.4、2.6、3.2–3.4）。
 *
 * 一次上传是一份报告（可以多个文件、多页），识别结果先放在“待核对”区，
 * 健管师核对确认后才写进正式的报告和指标表。所有响应里都没有客户姓名；
 * 原文件名只在识别记录详情里给服务该客户的健管师看，不进日志和存储路径。
 */

/** 上传限制（Q2、Q3、Q24）。后端按文件内容判断类型，不信任扩展名 */
export const REPORT_UPLOAD_LIMITS = {
  maxFiles: 10,
  maxPages: 30,
  maxFileBytes: 20 * 1024 * 1024,
  /** 失败后最多重新识别几次 */
  maxAttempts: 3,
  /** 每位健管师每天最多识别多少页 */
  dailyPages: 200,
} as const;

/** 支持的格式（Q2）：PDF（含扫描件）、JPG、PNG、HEIC；粘贴的截图是 PNG */
export const REPORT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
] as const;
export const reportMimeTypeSchema = z.enum(REPORT_MIME_TYPES);
export type ReportMimeType = z.infer<typeof reportMimeTypeSchema>;

/** 识别状态：排队中 → 识别中 → 待核对 → 已核对；任何时候可以放弃；失败后可以重试 */
export const REPORT_UPLOAD_STATUSES = [
  'queued',
  'processing',
  'needs_review',
  'verified',
  'failed',
  'discarded',
] as const;
export const reportUploadStatusSchema = z.enum(REPORT_UPLOAD_STATUSES);
export type ReportUploadStatus = z.infer<typeof reportUploadStatusSchema>;

/**
 * 识别失败的原因类别。transferred：客户在识别中或待核对时转给了别的健管师，
 * 未核对的结果作废，原件跟着客户走，新健管师可以重新识别（Q23）。
 */
export const EXTRACTION_FAILURE_CATEGORIES = [
  'not_a_report',
  'unreadable',
  'refused',
  'timeout',
  'too_large',
  'error',
  'transferred',
] as const;
export const extractionFailureCategorySchema = z.enum(EXTRACTION_FAILURE_CATEGORIES);
export type ExtractionFailureCategory = z.infer<typeof extractionFailureCategorySchema>;

/**
 * 识别结果每一行的标记。unit_unknown：单位缺失或换算表里没有，没有换算（Q11）。
 * duplicate：和同一天已有报告的同一指标数值相同，只提示，不要求逐行勾选。
 */
export const EXTRACTED_VALUE_FLAGS = [
  'unreadable',
  'out_of_bounds',
  'unit_converted',
  'unit_unknown',
  'unmapped',
  'conflict',
  'duplicate',
] as const;
export const extractedValueFlagSchema = z.enum(EXTRACTED_VALUE_FLAGS);
export type ExtractedValueFlag = z.infer<typeof extractedValueFlagSchema>;

/** 需特别注意、必须逐行勾选“已核对”的标记（Q18） */
export const ATTENTION_FLAGS: readonly ExtractedValueFlag[] = [
  'unreadable',
  'out_of_bounds',
  'unit_converted',
  'unit_unknown',
  'unmapped',
  'conflict',
];

export function needsAttention(flags: readonly ExtractedValueFlag[]): boolean {
  return flags.some((f) => ATTENTION_FLAGS.includes(f));
}

export const REVIEW_STATUSES = ['pending', 'checked', 'edited', 'deleted', 'added'] as const;
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const abnormalFlagSchema = z.enum(ABNORMAL_FLAGS);

export const reportFileSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  mimeType: reportMimeTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
  /** 原文件名，只给服务该客户的健管师看 */
  originalName: z.string(),
});
export type ReportFile = z.infer<typeof reportFileSchema>;

export const extractedValueSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  rawName: z.string(),
  /** 指标目录编码；未收录指标为空 */
  code: z.string().nullable(),
  /** 报告上印的数值和单位（健管师修改后是修改后的） */
  rawValue: z.string(),
  rawUnit: z.string().nullable(),
  /** 换算成目录单位后的数值；未收录指标是原值；读不出数字或单位不认识时为空 */
  value: z.number().nullable(),
  unit: z.string().nullable(),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  /** 报告上印的参考范围原文 */
  refText: z.string().nullable(),
  /** 第几页（从 1 开始），健管师补录的行可以为空 */
  page: z.number().int().positive().nullable(),
  sourceSnippet: z.string().nullable(),
  flags: z.array(extractedValueFlagSchema),
  reviewStatus: reviewStatusSchema,
  /** 需特别注意，确认前必须逐行勾选 */
  attention: z.boolean(),
  /** 按参考范围算的高低标记，仅供核对时参考 */
  abnormal: abnormalFlagSchema,
});
export type ExtractedValue = z.infer<typeof extractedValueSchema>;

export const reportUploadSummarySchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  taskId: z.uuid().nullable(),
  status: reportUploadStatusSchema,
  failureCategory: extractionFailureCategorySchema.nullable(),
  attempts: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  /** 正在识别第几页（从 1 开始）；还没开始为 0 */
  progressPage: z.number().int().nonnegative(),
  /** 核对后生成的正式报告 */
  reportId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportUploadSummary = z.infer<typeof reportUploadSummarySchema>;

export const reportUploadSchema = reportUploadSummarySchema.extend({
  /** 版本号：识别结果每改一次加一，确认核对时必须带最新的 */
  version: z.number().int().nonnegative(),
  /** 识别出的报告日期，确认时由健管师确认 */
  reportDate: z.iso.date().nullable(),
  institution: z.string().nullable(),
  files: z.array(reportFileSchema),
  values: z.array(extractedValueSchema),
  /** 同一报告日期已有的正式报告（Q17）；不为空时确认要选“作为新报告保存” */
  sameDateReportIds: z.array(z.uuid()),
  criticalAcknowledged: z.boolean(),
});
export type ReportUpload = z.infer<typeof reportUploadSchema>;

export const reportUploadResponseSchema = z.object({ upload: reportUploadSchema });
export type ReportUploadResponse = z.infer<typeof reportUploadResponseSchema>;

export const reportUploadListResponseSchema = z.object({
  uploads: z.array(reportUploadSummarySchema),
});
export type ReportUploadListResponse = z.infer<typeof reportUploadListResponseSchema>;

const rawNameSchema = z.string().trim().min(1).max(100);
const rawValueSchema = z.string().trim().min(1).max(50);
const unitSchema = z.string().trim().max(30);
const refTextSchema = z.string().trim().max(60);

/** 修改一项，或勾选“已核对”；deleted 删除识别错的行 */
export const updateExtractedValueRequestSchema = z
  .object({
    rawName: rawNameSchema.optional(),
    /** 指标目录编码；null 表示作为未收录指标保存 */
    code: z.string().nullable().optional(),
    rawValue: rawValueSchema.optional(),
    rawUnit: unitSchema.nullable().optional(),
    refText: refTextSchema.nullable().optional(),
    checked: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });
export type UpdateExtractedValueRequest = z.infer<typeof updateExtractedValueRequestSchema>;

/** 补录漏掉的一行 */
export const addExtractedValueRequestSchema = z.object({
  rawName: rawNameSchema,
  code: z.string().nullable().optional(),
  rawValue: rawValueSchema,
  rawUnit: unitSchema.nullable().optional(),
  refText: refTextSchema.nullable().optional(),
  page: z.number().int().positive().max(REPORT_UPLOAD_LIMITS.maxPages).nullable().optional(),
});
export type AddExtractedValueRequest = z.infer<typeof addExtractedValueRequestSchema>;

export const extractedValueResponseSchema = z.object({
  value: extractedValueSchema,
  version: z.number().int().nonnegative(),
});
export type ExtractedValueResponse = z.infer<typeof extractedValueResponseSchema>;

/** 确认核对（规格 2.4） */
export const verifyUploadRequestSchema = z.object({
  version: z.number().int().nonnegative(),
  /** 已勾选“已核对”的行；需特别注意的行必须都在里面（Q18） */
  checkedValueIds: z.array(z.uuid()).max(1000),
  reportDate: z.iso.date(),
  /** 有危急指标时必须勾选“已知悉” */
  acknowledgedCritical: z.boolean().default(false),
  /** 同一报告日期已有报告时，选择“作为新报告保存”（Q17） */
  saveAsNew: z.boolean().default(false),
});
export type VerifyUploadRequest = z.input<typeof verifyUploadRequestSchema>;

export const VERIFY_REJECTION_REASONS = [
  /** 别的窗口改过，版本号过期 */
  'stale_version',
  /** 已核对或已放弃，或还没识别完 */
  'not_reviewable',
  /** 需特别注意的行没有逐行勾选 */
  'unchecked_attention',
  /** 有危急指标，没有勾选“已知悉” */
  'critical_unacknowledged',
  /** 同一报告日期已有报告，没有选择“作为新报告保存” */
  'same_date_report',
  /** 目录指标没有数值（读不出数字或单位不认识），需要修改或删除 */
  'missing_value',
  /** 同一个指标出现了两行 */
  'duplicate_code',
  /** 没有任何指标 */
  'no_values',
] as const;
export const verifyRejectionReasonSchema = z.enum(VERIFY_REJECTION_REASONS);

/** 确认被拒绝时的响应（409）：原因、涉及的行、命中的危急指标 */
export const verifyRejectionSchema = z.object({
  error: z.literal('conflict'),
  reasons: z.array(verifyRejectionReasonSchema),
  valueIds: z.array(z.uuid()).optional(),
  critical: z.array(criticalFlagSchema).optional(),
  sameDateReportIds: z.array(z.uuid()).optional(),
});
export type VerifyRejection = z.infer<typeof verifyRejectionSchema>;

/** 正式报告里的一项指标 */
export const reportIndicatorSchema = z.object({
  id: z.uuid(),
  code: z.string().nullable(),
  rawName: z.string().nullable(),
  value: z.number().nullable(),
  unit: z.string(),
  originalValue: z.string().nullable(),
  originalUnit: z.string().nullable(),
  refLow: z.number().nullable(),
  refHigh: z.number().nullable(),
  refText: z.string().nullable(),
  /** 后端按报告上印的参考范围计算（Q10） */
  abnormal: abnormalFlagSchema,
  /** 更正后指向新的一行；为空是当前值 */
  supersededBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReportIndicator = z.infer<typeof reportIndicatorSchema>;

export const reportOriginalSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  mimeType: reportMimeTypeSchema,
  pageCount: z.number().int().positive(),
});

export const reportSchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  reportDate: z.iso.date(),
  institution: z.string().nullable(),
  source: reportSourceSchema,
  verifiedAt: z.iso.datetime().nullable(),
  /** 当前值 */
  indicators: z.array(reportIndicatorSchema),
  /** 更正历史：被更正掉的旧值 */
  corrections: z.array(reportIndicatorSchema),
  /** 报告原件；只有服务该客户的健管师能看，机构管理员为空（Q14） */
  files: z.array(reportOriginalSchema),
});
export type Report = z.infer<typeof reportSchema>;

export const reportResponseSchema = z.object({ report: reportSchema });
export type ReportResponse = z.infer<typeof reportResponseSchema>;

/** 已核对报告列表里的一项。不含文件名 */
export const reportListItemSchema = z.object({
  id: z.uuid(),
  reportDate: z.iso.date(),
  institution: z.string().nullable(),
  source: reportSourceSchema,
  indicatorCount: z.number().int().nonnegative(),
  abnormalCount: z.number().int().nonnegative(),
});
export type ReportListItem = z.infer<typeof reportListItemSchema>;

export const reportListResponseSchema = z.object({ reports: z.array(reportListItemSchema) });
export type ReportListResponse = z.infer<typeof reportListResponseSchema>;

/** 更正一项已核对的指标：插入新的一行，旧值保留可追溯（规格 2.4） */
export const correctIndicatorRequestSchema = z.object({
  rawValue: rawValueSchema,
  rawUnit: unitSchema.nullable().optional(),
  refText: refTextSchema.nullable().optional(),
});
export type CorrectIndicatorRequest = z.infer<typeof correctIndicatorRequestSchema>;

export const indicatorTrendResponseSchema = z.object({
  code: z.string(),
  points: z.array(
    z.object({
      reportId: z.uuid(),
      reportDate: z.iso.date(),
      source: reportSourceSchema,
      value: z.number(),
      unit: z.string(),
      originalValue: z.string().nullable(),
      originalUnit: z.string().nullable(),
      refLow: z.number().nullable(),
      refHigh: z.number().nullable(),
      refText: z.string().nullable(),
      abnormal: abnormalFlagSchema,
    }),
  ),
});
export type IndicatorTrendResponse = z.infer<typeof indicatorTrendResponseSchema>;

/** GET /api/report-uploads/:id/events 推送的事件。只有状态和页数，没有任何内容 */
export const reportUploadStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), upload: reportUploadSummarySchema }),
  z.object({ type: z.literal('done'), upload: reportUploadSummarySchema }),
  z.object({ type: z.literal('error'), kind: z.enum(['internal_error']) }),
]);
export type ReportUploadStreamEvent = z.infer<typeof reportUploadStreamEventSchema>;

/** 上传被拒绝的原因（413、415、409、429 时附带） */
export const UPLOAD_REJECTION_REASONS = [
  'too_many_files',
  'file_too_large',
  'too_many_pages',
  'unsupported_type',
  'duplicate_file',
  'daily_page_limit',
  'retry_limit',
] as const;
