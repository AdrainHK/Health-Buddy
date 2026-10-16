import { z } from 'zod';
import { artifactSummarySchema } from './artifacts.js';
import { clientGenderSchema, clientSummarySchema } from './clients.js';
import { riskTierRecordSchema } from './risk-tiers.js';

/**
 * 统一客户档案（M2 规格 2.2、3.3）。
 * 档案里的每个数值都带来源和日期；只含已核对的报告、日常监测和健管师手动录入的内容。
 */

/** 称呼的长度上限。M2 只收集称呼、性别、出生年份，不收集联系方式（Q13） */
export const CLIENT_NAME_MAX = 50;
export const BIRTH_YEAR_MIN = 1900;

const displayNameSchema = z.string().trim().min(1).max(CLIENT_NAME_MAX);
// 出生年份不能晚于今年；按解析时的年份判断，跨年后不用重新加载
const birthYearSchema = z
  .number()
  .int()
  .min(BIRTH_YEAR_MIN)
  .refine((year) => year <= new Date().getFullYear(), { message: 'birth year in the future' });

/** 新建客户。请求体里别的字段（如 operatorId、managerId）一律忽略，客户只能建在自己名下 */
export const createClientRequestSchema = z.object({
  displayName: displayNameSchema,
  gender: clientGenderSchema.nullable().optional(),
  birthYear: birthYearSchema.nullable().optional(),
});
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

export const updateClientRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    gender: clientGenderSchema.nullable().optional(),
    birthYear: birthYearSchema.nullable().optional(),
  })
  .refine(
    (v) => v.displayName !== undefined || v.gender !== undefined || v.birthYear !== undefined,
    { message: 'nothing to update' },
  );
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;

/** 健康史的五类（Q12），由健管师手动录入，AI 不自动写入 */
export const HEALTH_HISTORY_CATEGORIES = [
  'past_history',
  'family_history',
  'medication',
  'allergy',
  'lifestyle',
] as const;
export const healthHistoryCategorySchema = z.enum(HEALTH_HISTORY_CATEGORIES);
export type HealthHistoryCategory = z.infer<typeof healthHistoryCategorySchema>;

export const HEALTH_HISTORY_CONTENT_MAX = 500;

export const healthHistoryItemSchema = z.object({
  id: z.uuid(),
  category: healthHistoryCategorySchema,
  content: z.string(),
  /** 健管师填写的记录日期（如诊断或开始用药的日期），可空 */
  recordedOn: z.iso.date().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type HealthHistoryItem = z.infer<typeof healthHistoryItemSchema>;

const historyContentSchema = z.string().trim().min(1).max(HEALTH_HISTORY_CONTENT_MAX);

export const createHealthHistoryItemRequestSchema = z.object({
  category: healthHistoryCategorySchema,
  content: historyContentSchema,
  recordedOn: z.iso.date().nullable().optional(),
});
export type CreateHealthHistoryItemRequest = z.infer<typeof createHealthHistoryItemRequestSchema>;

export const updateHealthHistoryItemRequestSchema = z
  .object({
    category: healthHistoryCategorySchema.optional(),
    content: historyContentSchema.optional(),
    recordedOn: z.iso.date().nullable().optional(),
  })
  .refine(
    (v) => v.category !== undefined || v.content !== undefined || v.recordedOn !== undefined,
    { message: 'nothing to update' },
  );
export type UpdateHealthHistoryItemRequest = z.infer<typeof updateHealthHistoryItemRequestSchema>;

export const healthHistoryListResponseSchema = z.object({
  items: z.array(healthHistoryItemSchema),
});
export type HealthHistoryListResponse = z.infer<typeof healthHistoryListResponseSchema>;

export const healthHistoryItemResponseSchema = z.object({ item: healthHistoryItemSchema });
export type HealthHistoryItemResponse = z.infer<typeof healthHistoryItemResponseSchema>;

/** 报告来源：合成数据、上传后核对、手动录入 */
export const reportSourceSchema = z.enum(['synthetic', 'upload', 'manual']);
export type ReportSource = z.infer<typeof reportSourceSchema>;

/** 档案里的报告摘要。不含文件名 */
export const reportSummarySchema = z.object({
  id: z.uuid(),
  reportDate: z.iso.date(),
  source: reportSourceSchema,
  indicatorCount: z.number().int().nonnegative(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

/** 某个指标的历次数值，来自已核对的报告，按报告日期从新到旧 */
export const indicatorSeriesSchema = z.object({
  code: z.string(),
  points: z.array(
    z.object({
      reportId: z.uuid(),
      reportDate: z.iso.date(),
      source: reportSourceSchema,
      value: z.number(),
      unit: z.string(),
    }),
  ),
});
export type IndicatorSeries = z.infer<typeof indicatorSeriesSchema>;

export const monitoringSourceSchema = z.enum(['synthetic', 'device', 'manual', 'companion']);
export type MonitoringSource = z.infer<typeof monitoringSourceSchema>;

/** 最近 30 天某一项日常监测：最新一条和条数 */
export const monitoringSeriesSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  count: z.number().int().positive(),
  latest: z.object({
    value: z.number(),
    measuredAt: z.iso.datetime(),
    source: monitoringSourceSchema,
  }),
});
export type MonitoringSeries = z.infer<typeof monitoringSeriesSchema>;

export const MONITORING_RECORD_DAYS = 30;

export const clientRecordSchema = z.object({
  client: clientSummarySchema,
  /** 当前分层；为空表示未分层。只给健管师和机构管理员看，不进任何面向客户的内容（Q20） */
  riskTier: riskTierRecordSchema.nullable(),
  healthHistory: z.array(healthHistoryItemSchema),
  reports: z.array(reportSummarySchema),
  indicators: z.array(indicatorSeriesSchema),
  monitoring: z.array(monitoringSeriesSchema),
  /** 该客户所有任务里的产物。机构管理员看不到产物，始终为空（Q14） */
  artifacts: z.array(artifactSummarySchema),
  /** 机构管理员只读 */
  readOnly: z.boolean(),
});
export type ClientRecord = z.infer<typeof clientRecordSchema>;

export const clientRecordResponseSchema = z.object({ record: clientRecordSchema });
export type ClientRecordResponse = z.infer<typeof clientRecordResponseSchema>;
