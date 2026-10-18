import { z } from 'zod';

/**
 * 专家智能体中心（M3 规格第四节、第六节）的接口契约。
 *
 * 专家意见只给健管师看：客户端和伴侣不使用这里的任何结构（规格 7.2 第 2 条）。
 * 意见里的引用只能是 sourceId + 条目卡片编号，界面按编号去专家详情里取卡片要点显示。
 */

/** 专家 id：packages/experts 下的英文目录名，如 endocrine-metabolism */
export const EXPERT_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const expertIdSchema = z.string().regex(EXPERT_ID_PATTERN);
export type ExpertId = z.infer<typeof expertIdSchema>;

/**
 * 专家状态（规格 4.1）：draft 开发中；review 知识来源待确认，只在预览环境可用；
 * published 正式可用；retired 下架。
 */
export const EXPERT_STATUSES = ['draft', 'review', 'published', 'retired'] as const;
export const expertStatusSchema = z.enum(EXPERT_STATUSES);
export type ExpertStatus = z.infer<typeof expertStatusSchema>;

/** 一条消息最多 @ 3 位专家；一次调用最多请 3 位（Q5） */
export const EXPERTS_PER_CALL_MAX = 3;

/** 来源的确认状态（规格 5.1）：候选 / 已确认 / 已停用 */
export const SOURCE_STATUSES = ['candidate', 'confirmed', 'retired'] as const;
export const sourceStatusSchema = z.enum(SOURCE_STATUSES);

/**
 * 来源的使用范围（规格 5.1）：
 * - advice：健康管理内容（生活方式、监测、随访），摘成卡片并确认后可以作为要点和建议的依据；
 * - referral_only：诊断、治疗、用药、手术操作、急救类文件，只用来识别什么时候该转介，不能作为建议的依据。
 * 拿不准时一律标 referral_only。
 */
export const SOURCE_SCOPES = ['advice', 'referral_only'] as const;
export const sourceScopeSchema = z.enum(SOURCE_SCOPES);
export type SourceScope = z.infer<typeof sourceScopeSchema>;

/**
 * 来源优先级（规格 5.1）：1 国内官方指南 > 2 国内专家共识 > 3 国际学会指南 > 4 兜底细则。
 * 数字越小优先级越高；两张卡片说法冲突时采用优先级高的。3级国际学会指南只作对标参考，使用范围一律是 referral_only。
 */
export const SOURCE_PRIORITIES = [1, 2, 3, 4] as const;
export const sourcePrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type SourcePriority = z.infer<typeof sourcePrioritySchema>;

export const SOURCE_ID_PATTERN = /^S\d{1,3}$/;
export const CARD_ID_PATTERN = /^S\d{1,3}-\d{2,3}$/;

/** 意见里的一条引用：来源编号 + 条目卡片编号（规格 5.2 第 1 条） */
export const citationSchema = z.object({
  sourceId: z.string(),
  cardId: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

/** 引用的输入数据：指标名、数值、日期、来源（报告或日常监测） */
export const dataRefSchema = z.object({
  label: z.string(),
  value: z.string().nullable(),
  date: z.string().nullable(),
});
export type DataRef = z.infer<typeof dataRefSchema>;

/**
 * 每条要点。basis = cited 时必须有有效引用；data_only 只能描述数据，不能下专业判断（规格 5.2 第 3 条）。
 */
export const opinionFindingSchema = z.object({
  point: z.string(),
  basis: z.enum(['cited', 'data_only']),
  dataRefs: z.array(dataRefSchema),
  citations: z.array(citationSchema),
});
export type OpinionFinding = z.infer<typeof opinionFindingSchema>;

/**
 * 建议的类别（M3 合规审查）：只有 lifestyle（饮食、运动、作息等生活方式）可以被改写进 /体检解读 的通俗版；
 * follow_up（复查、就医、转介、跟进）和 communication（健管师怎么沟通、了解什么）只进专业版。
 */
export const SUGGESTION_CATEGORIES = ['lifestyle', 'follow_up', 'communication'] as const;
export const suggestionCategorySchema = z.enum(SUGGESTION_CATEGORIES);
export type SuggestionCategory = z.infer<typeof suggestionCategorySchema>;

export const opinionSuggestionSchema = z.object({
  text: z.string(),
  category: suggestionCategorySchema,
  citations: z.array(citationSchema),
});
export type OpinionSuggestion = z.infer<typeof opinionSuggestionSchema>;

/** 转介的两档沿用 M1 危急指标：attention 建议就医评估 / urgent 需尽快就医 */
export const referralUrgencySchema = z.enum(['attention', 'urgent']);
export type ReferralUrgency = z.infer<typeof referralUrgencySchema>;

export const referralSchema = z.object({
  needed: z.boolean(),
  urgency: referralUrgencySchema.nullable(),
  /** 转介的科室或专业人员类别，如“内分泌科医生”“注册营养师” */
  to: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Referral = z.infer<typeof referralSchema>;

/**
 * 通用意见结构（规格 4.2）。也是发给模型的结构化输出约定：字段都必填、可空的用 null，
 * 两家厂商的结构化输出都能约束。免责声明由后端拼接，模型不写。
 */
export const expertOpinionSchema = z.object({
  inScope: z.boolean(),
  /** inScope 为 false 时：建议改问哪位专家或转介哪类医生 */
  outOfScopeNote: z.string().nullable(),
  summary: z.string(),
  findings: z.array(opinionFindingSchema),
  suggestions: z.array(opinionSuggestionSchema),
  referral: referralSchema,
  questionsToAsk: z.array(z.string()),
  dataGaps: z.array(z.string()),
  /** 输入里有自伤、轻生等心理危机信号 */
  crisisSignal: z.boolean(),
  /** 输入里有胸痛、晕厥、意识不清、呼吸困难等疑似急症描述 */
  emergencySignal: z.boolean(),
});
export type ExpertOpinion = z.infer<typeof expertOpinionSchema>;

/** 专家库卡片（GET /api/experts） */
export const expertSummarySchema = z.object({
  id: expertIdSchema,
  name: z.string(),
  tagline: z.string(),
  version: z.string(),
  status: expertStatusSchema,
  /** 对当前账号可用（未被平台暂停、当前环境允许这个状态） */
  available: z.boolean(),
  /** 知识来源还没有全部经医学顾问确认：卡片上醒目标出“仅供试用”（规格 2.2、Q2） */
  sourcesPending: z.boolean(),
});
export type ExpertSummary = z.infer<typeof expertSummarySchema>;

export const expertListResponseSchema = z.object({ experts: z.array(expertSummarySchema) });
export type ExpertListResponse = z.infer<typeof expertListResponseSchema>;

/**
 * 来源清单的一行。未确认的颁布机构和版本不显示（规格 5.2 第 4 条）；
 * section 是清单里的病种分组标题，priority 和 scope 见上。
 */
export const expertSourceSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  section: z.string().nullable(),
  publisher: z.string().nullable(),
  version: z.string().nullable(),
  priority: sourcePrioritySchema,
  scope: sourceScopeSchema,
  status: sourceStatusSchema,
});
export type ExpertSource = z.infer<typeof expertSourceSchema>;

/** 条目卡片（点开引用时显示）：来源、章节和要点 */
export const expertCardSchema = z.object({
  cardId: z.string(),
  sourceId: z.string(),
  section: z.string(),
  point: z.string(),
  /** 来源的使用范围：referral_only 的卡片只用来判断是否转介，不能被引用为建议依据 */
  scope: sourceScopeSchema,
  confirmed: z.boolean(),
});
export type ExpertCard = z.infer<typeof expertCardSchema>;

/** 专家详情（GET /api/experts/:id） */
export const expertDetailSchema = expertSummarySchema.extend({
  strengths: z.array(z.string()),
  outOfScope: z.array(z.string()),
  sources: z.array(expertSourceSchema),
  cards: z.array(expertCardSchema),
  /** 本人使用次数（Q15） */
  myUsageCount: z.number().int().nonnegative(),
});
export type ExpertDetail = z.infer<typeof expertDetailSchema>;

/** 选中专家的原因类别（规格 2.6：展开后显示选中原因） */
export const routingReasonSchema = z.discriminatedUnion('kind', [
  /** 健管师 @ 或“一定要请” */
  z.object({ kind: z.literal('manager') }),
  /** 报告中某项指标高于、低于参考范围或没有参考范围 */
  z.object({
    kind: z.literal('indicator'),
    code: z.string().nullable(),
    direction: z.enum(['high', 'low', 'no_reference']),
  }),
  /** 模型按要求或健康史补充 */
  z.object({
    kind: z.literal('model'),
    category: z.enum(['manager_request', 'health_history', 'indicator_relation']),
  }),
  /** 专家中心发起的任务绑定的专家 */
  z.object({ kind: z.literal('bound') }),
]);
export type RoutingReason = z.infer<typeof routingReasonSchema>;

export const SELECTED_REASONS = ['manager', 'rule', 'model'] as const;
export type SelectedReason = (typeof SELECTED_REASONS)[number];

/** 路由决定（规格 3.2），写进 expert_consultations.routing */
export const routingDecisionSchema = z.object({
  selected: z.array(
    z.object({
      expertId: expertIdSchema,
      selectedReason: z.enum(SELECTED_REASONS),
      reasons: z.array(routingReasonSchema),
    }),
  ),
  /** 健管师“不要请”的专家 */
  excluded: z.array(expertIdSchema),
  /** 因数量上限未调用的专家（可以“也请这位”） */
  overCap: z.array(expertIdSchema),
  /** 模型路由失败，只用了规则命中的结果 */
  ruleOnly: z.boolean(),
});
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** 一处分歧：话题，以及每位相关专家的观点和依据（原样引用），不选边、不调和 */
export const disagreementSchema = z.object({
  topic: z.string(),
  positions: z.array(
    z.object({
      expertId: expertIdSchema,
      view: z.string(),
      citations: z.array(citationSchema),
    }),
  ),
  /** 由后端按转介建议确定性生成（“是否需要就医评估”，规格 3.5） */
  generatedByBackend: z.boolean(),
});
export type Disagreement = z.infer<typeof disagreementSchema>;

/** 汇总（规格 3.5）。转介、危机和急症信号由后端确定性合并，不交给模型 */
export const synthesisSchema = z.object({
  consensus: z.array(
    z.object({
      point: z.string(),
      experts: z.array(expertIdSchema),
      citations: z.array(citationSchema),
    }),
  ),
  disagreements: z.array(disagreementSchema),
  referrals: z.array(
    z.object({
      expertId: expertIdSchema,
      urgency: referralUrgencySchema.nullable(),
      to: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  followUpPoints: z.array(z.string()),
  crisisSignal: z.boolean(),
  emergencySignal: z.boolean(),
  /** 没能回复的专家（超时、出错、拒答），汇总里写明 */
  missingExperts: z.array(expertIdSchema),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

export const EXPERT_CALL_STATUSES = [
  'running',
  'done',
  'failed',
  'timeout',
  'refused',
  'stopped',
] as const;
export const expertCallStatusSchema = z.enum(EXPERT_CALL_STATUSES);
export type ExpertCallStatus = z.infer<typeof expertCallStatusSchema>;

/** 失败只带类别，不带厂商原始错误（规格 6.4） */
export const EXPERT_FAILURE_CATEGORIES = [
  'timeout',
  'refused',
  'invalid_output',
  'provider_error',
] as const;
export const expertFailureCategorySchema = z.enum(EXPERT_FAILURE_CATEGORIES);
export type ExpertFailureCategory = z.infer<typeof expertFailureCategorySchema>;

export const expertCallSchema = z.object({
  id: z.uuid(),
  expertId: expertIdSchema,
  expertVersion: z.string(),
  selectedReason: z.enum(SELECTED_REASONS),
  status: expertCallStatusSchema,
  failureCategory: expertFailureCategorySchema.nullable(),
  opinion: expertOpinionSchema.nullable(),
  /** 因依据无法核实被移除的要点数量（规格 3.4 第 5 条） */
  removedFindings: z.number().int().nonnegative(),
  /** 当前健管师对这条意见的反馈 */
  feedback: z
    .object({
      rating: z.enum(['useful', 'not_useful']),
      reason: z
        .enum(['inaccurate', 'too_general', 'out_of_scope', 'bad_citation', 'other'])
        .nullable(),
    })
    .nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ExpertCall = z.infer<typeof expertCallSchema>;

export const CONSULTATION_TRIGGERS = ['expert_center', 'mention', 'skill_auto', 'plan'] as const;
export const consultationTriggerSchema = z.enum(CONSULTATION_TRIGGERS);
export type ConsultationTrigger = z.infer<typeof consultationTriggerSchema>;

export const CONSULTATION_STATUSES = ['running', 'done', 'partial', 'failed', 'stopped'] as const;
export const consultationStatusSchema = z.enum(CONSULTATION_STATUSES);
export type ConsultationStatus = z.infer<typeof consultationStatusSchema>;

export const synthesisStatusSchema = z.enum(['skipped', 'done', 'failed']);
export type SynthesisStatus = z.infer<typeof synthesisStatusSchema>;

export const expertConsultationSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  messageId: z.uuid(),
  trigger: consultationTriggerSchema,
  status: consultationStatusSchema,
  routing: routingDecisionSchema,
  synthesis: synthesisSchema.nullable(),
  synthesisStatus: synthesisStatusSchema.nullable(),
  calls: z.array(expertCallSchema),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ExpertConsultation = z.infer<typeof expertConsultationSchema>;

export const expertConsultationListResponseSchema = z.object({
  consultations: z.array(expertConsultationSchema),
});
export type ExpertConsultationListResponse = z.infer<typeof expertConsultationListResponseSchema>;

/** 反馈只收类别，不收自由文字（Q14）；选“有用”时没有原因 */
export const expertFeedbackRequestSchema = z
  .object({
    rating: z.enum(['useful', 'not_useful']),
    reason: z
      .enum(['inaccurate', 'too_general', 'out_of_scope', 'bad_citation', 'other'])
      .nullable()
      .default(null),
  })
  .strict()
  .refine((v) => v.rating === 'not_useful' || v.reason === null, {
    message: 'reason only for not_useful',
    path: ['reason'],
  });
export type ExpertFeedbackRequest = z.input<typeof expertFeedbackRequestSchema>;

/** 平台管理员暂停或恢复专家（Q11） */
export const setExpertAvailabilityRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type SetExpertAvailabilityRequest = z.infer<typeof setExpertAvailabilityRequestSchema>;

/** SSE：每位专家的状态单独推送（规格 2.6） */
export const expertCallEventSchema = z.object({
  type: z.literal('expert_call'),
  consultationId: z.uuid(),
  expertId: expertIdSchema,
  status: expertCallStatusSchema,
  failureCategory: expertFailureCategorySchema.nullable(),
});

/** SSE：一次专家调用结束 */
export const consultationEventSchema = z.object({
  type: z.literal('consultation'),
  consultationId: z.uuid(),
  status: consultationStatusSchema,
});
