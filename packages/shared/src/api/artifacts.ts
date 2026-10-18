import { z } from 'zod';
import { CRITICAL_COMPARATORS, CRITICAL_LEVELS } from '../health/critical.js';
import { riskTierSuggestionSchema } from './risk-tiers.js';

/** 产物状态（规格 3.6）。voided 只由系统在客户转出或删除时设置（Q11）。 */
export const artifactStatusSchema = z.enum(['draft', 'approved', 'returned', 'voided']);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const artifactContentSchema = z.object({
  /** 专业版，只给健管师看 */
  professional: z.string(),
  /** 通俗版，审核后可给客户；免责声明由后端拼接 */
  clientFacing: z.string(),
});
export type ArtifactContent = z.infer<typeof artifactContentSchema>;

/** 后端按阈值识别出的危急指标，只给健管师看，不进通俗版 */
export const criticalFlagSchema = z.object({
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  observedOn: z.iso.date(),
  source: z.enum(['monitoring', 'report']),
  /** 命中时生效的规则快照，阈值以后改了也能追溯 */
  rule: z.object({
    comparator: z.enum(CRITICAL_COMPARATORS),
    value: z.number(),
    level: z.enum(CRITICAL_LEVELS),
  }),
});
export type CriticalFlag = z.infer<typeof criticalFlagSchema>;

export const artifactSummarySchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  skillId: z.string(),
  version: z.number().int().positive(),
  status: artifactStatusSchema,
  hasCriticalFlags: z.boolean(),
  createdAt: z.iso.datetime(),
  /**
   * 依据的已核对报告的日期和第一个原件的文件名，只用于健管师界面上的产物标题
   * （验收反馈：“体检报告（文件名）解读 · 第 1 版”）；没有依据报告、报告不是上传的或已看不到时为空
   */
  sourceReportDate: z.iso.date().nullable().default(null),
  sourceFileName: z.string().nullable().default(null),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactSchema = artifactSummarySchema.extend({
  clientId: z.uuid().nullable(),
  parentId: z.uuid().nullable(),
  content: artifactContentSchema,
  /**
   * 内容指纹。修改和确认时必须带上健管师预览时的指纹，
   * 保证确认的内容和预览一致（别的窗口改过就拒绝）。
   */
  contentHash: z.string(),
  criticalFlags: z.array(criticalFlagSchema),
  /** /体检解读、/面谈提纲 依据的已核对报告（M2 规格 3.2）；客户转出或删除后为空 */
  sourceReportId: z.uuid().nullable(),
  /**
   * AI 给出的建议分层（规格 2.7），只给健管师看，不进通俗版、复制和导出（Q20）。
   * 只有 /体检解读 且输入里有分层标准时才有。
   */
  riskTierSuggestion: riskTierSuggestionSchema.nullable(),
  /**
   * 这份产物有没有通俗版（取自技能定义）。/面谈提纲 只有专业版（规格 2.8）：
   * 不能复制、导出，界面上不显示通俗版。
   */
  clientFacing: z.boolean().default(true),
  /** 产物用到的专家调用（M3 规格 6.2）；没有调用专家时为空 */
  consultationId: z.uuid().nullable().default(null),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const ARTIFACT_ACTIONS = [
  'created',
  'edited',
  'approved',
  'returned',
  'voided',
  'copied',
  'exported',
] as const;

/** 修改、审核、复制和导出记录。只记谁在什么时候做了什么，不记内容。 */
export const artifactEventSchema = z.object({
  id: z.uuid(),
  artifactId: z.uuid(),
  actorId: z.uuid().nullable(),
  action: z.enum(ARTIFACT_ACTIONS),
  reason: z.string().nullable(),
  format: z.enum(['png', 'pdf']).nullable(),
  createdAt: z.iso.datetime(),
});
export type ArtifactEvent = z.infer<typeof artifactEventSchema>;

/** 通俗版的提示项：只提示、不拦截（规格 3.6），位置按原文的 UTF-16 下标 */
export const clientTextHintsSchema = z.object({
  /** 疾病名称和“患有”“有……风险”这类判断句式 */
  judgementHints: z.array(z.object({ text: z.string(), index: z.number().int() })),
  /**
   * 通俗版里出现的危急指标数值（只给指标编码和位置，不给数值）。
   * 有就不能确认；详情里提前给出，打开草稿时就能标出，不必等确认被拒绝。
   */
  criticalValueMentions: z.array(z.object({ metric: z.string(), index: z.number().int() })),
  /** 通俗版里出现的风险分层字样（Q20）。有就不能确认 */
  riskTierMentions: z.array(z.object({ text: z.string(), index: z.number().int() })).default([]),
});
export type ClientTextHints = z.infer<typeof clientTextHintsSchema>;

/** 产物依据的报告（只有日期和是否更正过，不含数值） */
export const artifactSourceReportSchema = z.object({
  id: z.uuid(),
  reportDate: z.iso.date(),
  /** 生成之后报告里有指标被更正过：草稿顶部提示“报告数值已更正，建议重新生成”（规格 2.4） */
  correctedSince: z.boolean(),
});
export type ArtifactSourceReport = z.infer<typeof artifactSourceReportSchema>;

export const artifactDetailResponseSchema = z.object({
  artifact: artifactSchema,
  /** 依据的报告；没有或已看不到时为空 */
  sourceReport: artifactSourceReportSchema.nullable().default(null),
  hints: clientTextHintsSchema,
  /** 同一产物链上的所有版本，按版本号升序 */
  versions: z.array(artifactSummarySchema),
  events: z.array(artifactEventSchema),
});
export type ArtifactDetailResponse = z.infer<typeof artifactDetailResponseSchema>;

export const ARTIFACT_TEXT_MAX = 20000;
export const RETURN_REASON_MAX = 500;

const contentHashField = z.string().min(1).max(128);

export const updateArtifactRequestSchema = z.object({
  version: z.number().int().positive(),
  contentHash: contentHashField,
  content: z.object({
    professional: z.string().max(ARTIFACT_TEXT_MAX),
    clientFacing: z.string().max(ARTIFACT_TEXT_MAX),
  }),
});
export type UpdateArtifactRequest = z.infer<typeof updateArtifactRequestSchema>;

export const approveArtifactRequestSchema = z.object({
  /** 必须等于最新草稿的版本号 */
  version: z.number().int().positive(),
  /** 必须等于健管师预览时的内容指纹 */
  contentHash: contentHashField,
  /** 有危急指标时必须为 true */
  acknowledgedCritical: z.boolean().default(false),
  /**
   * 采用产物里的建议分层（规格 2.7）：后端在同一事务里写入分层历史，来源记为这份产物。
   * 不勾选就不改分层。产物没有建议分层时勾选会被拒绝。
   */
  adoptRiskTier: z.boolean().default(false),
});
export type ApproveArtifactRequest = z.input<typeof approveArtifactRequestSchema>;

export const returnArtifactRequestSchema = z.object({
  reason: z.string().trim().min(1).max(RETURN_REASON_MAX),
});
export type ReturnArtifactRequest = z.infer<typeof returnArtifactRequestSchema>;

export const exportFormatSchema = z.enum(['png', 'pdf']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** POST /api/artifacts/:id/export：会写导出记录，所以用 POST；响应是文件 */
export const exportArtifactRequestSchema = z.object({ format: exportFormatSchema });
export type ExportArtifactRequest = z.infer<typeof exportArtifactRequestSchema>;

export const clientTextResponseSchema = z.object({ text: z.string() });
export type ClientTextResponse = z.infer<typeof clientTextResponseSchema>;

/** 确认被拒绝时的原因，前端据此标出问题位置 */
export const approveRejectionSchema = z.object({
  error: z.literal('conflict'),
  reasons: z.array(
    z.enum([
      'not_latest_draft',
      'banned_terms',
      'missing_disclaimer',
      'duplicate_disclaimer',
      'empty_client_text',
      'critical_not_acknowledged',
      /** 通俗版里出现了危急指标的数值，危急指标永远不进通俗版 */
      'critical_value_in_client_text',
      /** 通俗版里出现了风险分层的字样，分层只给健管师看（Q20） */
      'risk_tier_in_client_text',
      /** 勾选了“采用建议分层”，但这份产物没有建议分层 */
      'no_risk_tier_suggestion',
      'read_only',
    ]),
  ),
  bannedTerms: z.array(z.object({ term: z.string(), index: z.number().int() })).optional(),
  criticalValueMentions: z
    .array(z.object({ metric: z.string(), index: z.number().int() }))
    .optional(),
  riskTierMentions: z.array(z.object({ text: z.string(), index: z.number().int() })).optional(),
});
export type ApproveRejection = z.infer<typeof approveRejectionSchema>;
