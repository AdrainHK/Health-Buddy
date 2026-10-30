import { z } from 'zod';
import { CRITICAL_COMPARATORS, CRITICAL_LEVELS } from '../health/critical.js';
import { timeZoneSchema } from './follow-ups.js';
import { riskTierSuggestionSchema } from './risk-tiers.js';
import { planOptionsSchema } from './care-plans.js';

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
  /** 专家意见里有疑似急症信号：审核栏醒目提示（M3 合规审查） */
  emergencySignal: z.boolean().default(false),
  /** 有心理危机信号（关键词，或专家、汇总标出）：审核栏醒目提示 */
  crisisSignal: z.boolean().default(false),
  /**
   * 按 kind 的结构化内容（M5 规格 6.2、6.3）：care_plan 是 carePlanStructuredSchema，
   * visit_schedule 是 visitScheduleStructuredSchema，visit_record 是 visitRecordStructuredSchema；
   * 其他产物为空。专业版和通俗版文字由后端从这里和库条目渲染
   */
  structured: z.unknown().nullable().default(null),
  /** /方案生成 的选项（部分、周期）；其他产物为空 */
  planOptions: planOptionsSchema.nullable().default(null),
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
  /** 同步给伴侣“福宝”（M6 规格 2.8） */
  'companion_synced',
  /** 取消同步给伴侣 */
  'companion_withdrawn',
  /** /转交回复 审核后发送给福宝（M6 规格 2.4） */
  'companion_reply_sent',
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
  /**
   * 同步给伴侣（M6 规格 2.8、N12）：只有方案和报告解读有。available：客户有有效同意且已绑定设备；
   * syncedAt：在用的同步时间（取消同步、被替代后为空）；superseded：同步过、后来被这位客户更新的同类内容替代。
   * 其他产物为空
   */
  companion: z
    .object({
      available: z.boolean(),
      syncedAt: z.iso.datetime().nullable(),
      superseded: z.boolean().default(false),
    })
    .nullable()
    .default(null),
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
  /**
   * 结构化内容（只限 care_plan、visit_schedule、visit_record，M5 规格 2.3、2.7、2.9）：替换库条目、
   * 改目标参数、改日程、补填随访记录的日期和方式。后端按 kind 用对应的 schema 校验：条目未发布、
   * 参数超范围、日程日期早于今天或超过 6 个月后、随访记录日期在今天之后 → 400
   */
  structured: z.unknown().optional(),
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
  /** 方案用到的食谱和过敏史有匹配时必须为 true（M5 Q16） */
  acknowledgedAllergens: z.boolean().default(false),
  /**
   * 只限 visit_record（M5 Q26）：一并标为“已处理（已电话联系）”的跟进项，必须是这位客户未处理的跟进项，
   * 有一个不是就 404 且整个事务回滚
   */
  resolveFollowUpItemIds: z
    .array(z.uuid())
    .max(20)
    .refine((v) => new Set(v).size === v.length, { message: 'duplicate follow-up item' })
    .default([]),
});
export type ApproveArtifactRequest = z.input<typeof approveArtifactRequestSchema>;

export const returnArtifactRequestSchema = z.object({
  reason: z.string().trim().min(1).max(RETURN_REASON_MAX),
  /**
   * M3（Q21）：退回重写默认复用这份草稿生成时的专家意见；为 true 时重新请专家（新的调用记录，计入每日用量）。
   * 依据的报告数值被更正过时，不论这里怎么传都会重新请专家。
   */
  reconsult: z.boolean().optional(),
});
export type ReturnArtifactRequest = z.infer<typeof returnArtifactRequestSchema>;

export const exportFormatSchema = z.enum(['png', 'pdf']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** POST /api/artifacts/:id/export：会写导出记录，所以用 POST；响应是文件 */
export const exportArtifactRequestSchema = z.object({
  format: exportFormatSchema,
  /**
   * 健管师的时区（浏览器时区）。导出文件名里的日期是这一版的生成日期，按这个时区算；
   * 不传或时区不存在时按北京时间
   */
  tz: timeZoneSchema.optional(),
});
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
      // M5 规格 2.3、2.7、6.3
      /** 通俗版里出现了药名或用药建议 */
      'drug_in_client_text',
      /** 通俗版里出现了孪生状态颜色或预测字样 */
      'twin_in_client_text',
      /** 通俗版里出现了专家名称 */
      'expert_in_client_text',
      /** 引用的库条目已不是已发布状态 */
      'library_item_unavailable',
      /** 目标参数超出模板范围 */
      'goal_param_out_of_range',
      /** 用到的食谱和过敏史有匹配，没有勾选“已核对过敏原” */
      'allergens_not_acknowledged',
      /** 随访计划的日期不合规（早于今天、超过 6 个月后、重复） */
      'schedule_mismatch',
      /** 随访记录还没填随访日期或方式，或日期在今天之后 */
      'record_incomplete',
      // M6 规格 2.9：/转交回复
      /** 回复为空、超过 150 字，或有只给健管师看的提示语，不能念给客户 */
      'reply_invalid',
    ]),
  ),
  bannedTerms: z.array(z.object({ term: z.string(), index: z.number().int() })).optional(),
  criticalValueMentions: z
    .array(z.object({ metric: z.string(), index: z.number().int() }))
    .optional(),
  riskTierMentions: z.array(z.object({ text: z.string(), index: z.number().int() })).optional(),
});
export type ApproveRejection = z.infer<typeof approveRejectionSchema>;
