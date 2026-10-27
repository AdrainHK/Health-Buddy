import { z } from 'zod';
import { CRITICAL_COMPARATORS, CRITICAL_LEVELS } from '../health/critical.js';
import { FORECAST_METRICS } from '../health/forecast.js';
import {
  TWIN_DOMAINS,
  TWIN_LEVELS,
  TWIN_REASON_MAX,
  TWIN_REASON_MIN,
  TWIN_RULE_LEVELS,
  TWIN_RULE_METHODS,
  TWIN_RULE_SOURCES,
} from '../health/twin.js';
import { planSectionSchema } from '../plan/library.js';
import { visitMethodSchema, visitPurposeSchema } from '../plan/visit-schedule.js';
import { carePlanEndReasonSchema } from './care-plans.js';
import { clientSummarySchema } from './clients.js';
import { riskTierRecordSchema } from './risk-tiers.js';

/**
 * 客户数字孪生（M4 规格 2.2–2.5、7.3）。
 * 孪生只给健管师（和只读的机构管理员）看，不进任何发给客户的内容（Q5、Q10）。
 * 所有数值、依据、预测都由后端确定性计算，不经大模型。
 */

export const twinDomainSchema = z.enum(TWIN_DOMAINS);
export const twinLevelSchema = z.enum(TWIN_LEVELS);
export const twinRuleSourceSchema = z.enum(TWIN_RULE_SOURCES);
export const twinRuleMethodSchema = z.enum(TWIN_RULE_METHODS);
export const twinRuleLevelSchema = z.enum(TWIN_RULE_LEVELS);

/** 命中的规则和当时的规则快照（规则以后改了也能追溯，同 M1 的危急指标快照） */
export const twinRuleHitSchema = z.discriminatedUnion('method', [
  z.object({
    ruleId: z.string(),
    method: z.literal('critical'),
    level: twinRuleLevelSchema,
    snapshot: z.object({
      comparator: z.enum(CRITICAL_COMPARATORS),
      value: z.number(),
      unit: z.string(),
      windowDays: z.number().int().nullable(),
      criticalLevel: z.enum(CRITICAL_LEVELS),
    }),
  }),
  z.object({
    ruleId: z.string(),
    method: z.literal('out_of_reference'),
    level: twinRuleLevelSchema,
    snapshot: z.object({
      refLow: z.number().nullable(),
      refHigh: z.number().nullable(),
      abnormal: z.enum(['high', 'low']),
    }),
  }),
  z.object({
    ruleId: z.string(),
    method: z.literal('threshold'),
    level: twinRuleLevelSchema,
    snapshot: z.object({
      comparator: z.enum(CRITICAL_COMPARATORS),
      value: z.number(),
      unit: z.string(),
      windowDays: z.number().int(),
      average: z.number(),
      count: z.number().int().positive(),
    }),
  }),
]);
export type TwinRuleHit = z.infer<typeof twinRuleHitSchema>;

const basisCommon = {
  metric: z.string(),
  value: z.number(),
  unit: z.string(),
  /** YYYY-MM-DD：报告日期，或监测窗口内最近一条的日期 */
  observedOn: z.iso.date(),
  /** 这个数值单独判断的结果 */
  outcome: z.enum(['red', 'yellow', 'green']),
  hits: z.array(twinRuleHitSchema),
};

/**
 * 状态依据里的一个数值（2.3、4.2 第 5 条）。含健康数值，只存数据库、只给健管师和机构管理员看，
 * 不进日志和埋点。
 */
export const twinBasisItemSchema = z.discriminatedUnion('source', [
  z.object({
    ...basisCommon,
    source: z.literal('report'),
    reportId: z.string(),
    indicatorId: z.string(),
    refLow: z.number().nullable(),
    refHigh: z.number().nullable(),
    /** 报告没印参考范围：不按“参考范围”类规则判断，依据里写“报告未提供参考范围” */
    noReference: z.boolean(),
  }),
  z.object({
    ...basisCommon,
    source: z.literal('monitoring'),
    /** value 是窗口内的平均值 */
    windowDays: z.number().int().positive(),
    count: z.number().int().positive(),
    from: z.iso.date(),
    latestValue: z.number(),
    latestReadingId: z.string(),
  }),
]);
export type TwinBasisItem = z.infer<typeof twinBasisItemSchema>;

/** 没有参与判断的数值。不带数值，只说原因 */
export const twinSkippedValueSchema = z.object({
  metric: z.string(),
  source: twinRuleSourceSchema,
  observedOn: z.iso.date(),
  reason: z.enum(['unit_mismatch', 'out_of_bounds', 'stale', 'not_in_catalog']),
});
export type TwinSkippedValue = z.infer<typeof twinSkippedValueSchema>;

/** 状态的来源：系统按规则计算、健管师手动调整、健管师取消调整 */
export const TWIN_STATUS_ORIGINS = ['computed', 'manual', 'manual_cleared'] as const;
export const twinStatusOriginSchema = z.enum(TWIN_STATUS_ORIGINS);
export type TwinStatusOrigin = z.infer<typeof twinStatusOriginSchema>;

/**
 * 手动调整什么时候失效。Q4 已确认：到这个方面下次有新数据时失效（next_data）；
 * never 只为以后保留，接口不接受。
 */
export const TWIN_MANUAL_EXPIRES = ['next_data', 'never'] as const;

/**
 * 状态历史是因为什么写入的。backfill：M4 上线前已有数据的客户第一次打开孪生时补算
 * （和规则修改一样按批量处理，不生成跟进项）。
 */
export const TWIN_STATUS_TRIGGERS = [
  'report_verified',
  'correction',
  'monitoring',
  'rules_changed',
  'thresholds_changed',
  'manual',
  'seed',
  'backfill',
] as const;
export const twinStatusTriggerSchema = z.enum(TWIN_STATUS_TRIGGERS);
export type TwinStatusTrigger = z.infer<typeof twinStatusTriggerSchema>;

/** 计算任务的触发原因（不含手动调整）。批量触发（规则、阈值修改和补算）不生成跟进项（Q22） */
export const TWIN_COMPUTE_TRIGGERS = [
  'report_verified',
  'correction',
  'monitoring',
  'rules_changed',
  'thresholds_changed',
  'seed',
  'backfill',
] as const satisfies readonly TwinStatusTrigger[];
export type TwinComputeTrigger = (typeof TWIN_COMPUTE_TRIGGERS)[number];
export const TWIN_BATCH_TRIGGERS = [
  'rules_changed',
  'thresholds_changed',
  'backfill',
] as const satisfies readonly TwinComputeTrigger[];
export function isBatchTwinTrigger(t: TwinComputeTrigger): boolean {
  return (TWIN_BATCH_TRIGGERS as readonly string[]).includes(t);
}

/** 状态历史的一行（只在状态变化时插入；最新一行就是当前状态） */
export const twinStatusRecordSchema = z.object({
  id: z.uuid(),
  domain: twinDomainSchema,
  level: twinLevelSchema,
  origin: twinStatusOriginSchema,
  basis: z.array(twinBasisItemSchema),
  rulesVersion: z.number().int().nonnegative(),
  /** 手动调整的理由；只给健管师和机构管理员看 */
  reason: z.string().nullable(),
  manualExpires: z.enum(TWIN_MANUAL_EXPIRES).nullable(),
  trigger: twinStatusTriggerSchema,
  setBy: z.uuid().nullable(),
  /** 调整人姓名；客户从别的健管师转来时看不到原健管师的姓名，为空 */
  setByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TwinStatusRecord = z.infer<typeof twinStatusRecordSchema>;

/** 一个方面的当前状态：系统计算和手动调整同时保留（2.3） */
export const twinDomainViewSchema = z.object({
  domain: twinDomainSchema,
  /** 界面上显示的状态：有效的手动调整优先，否则是系统计算 */
  level: twinLevelSchema,
  computed: twinStatusRecordSchema.nullable(),
  manual: twinStatusRecordSchema.nullable(),
  /** 手动调整因新数据失效、已恢复系统计算（卡片上提示） */
  manualExpiredByNewData: z.boolean(),
  /** 和上次相比：上一次的状态和变化时间 */
  previousLevel: twinLevelSchema.nullable(),
  changedAt: z.iso.datetime().nullable(),
});
export type TwinDomainView = z.infer<typeof twinDomainViewSchema>;

export const setTwinStatusRequestSchema = z.object({
  domain: twinDomainSchema,
  /** 手动调整只能调成红黄绿，不能调成“数据不足” */
  level: z.enum(['red', 'yellow', 'green']),
  reason: z.string().trim().min(TWIN_REASON_MIN).max(TWIN_REASON_MAX),
  expires: z.literal('next_data').default('next_data'),
});
export type SetTwinStatusRequest = z.infer<typeof setTwinStatusRequestSchema>;

/** 取消手动调整（DELETE /api/clients/:id/twin/status/:domain 的路径参数） */
export const clearTwinStatusRequestSchema = z.object({ domain: twinDomainSchema });
export type ClearTwinStatusRequest = z.infer<typeof clearTwinStatusRequestSchema>;

export const twinStatusHistoryResponseSchema = z.object({
  records: z.array(twinStatusRecordSchema),
});
export type TwinStatusHistoryResponse = z.infer<typeof twinStatusHistoryResponseSchema>;

// ---------- 趋势预测（第六节） ----------

export const forecastPointSchema = z.object({
  monthsAhead: z.union([z.literal(3), z.literal(6)]),
  date: z.iso.date(),
  mid: z.number(),
  low: z.number(),
  high: z.number(),
  /** 区间被截在合理范围内 */
  clipped: z.boolean(),
});
export type ForecastPoint = z.infer<typeof forecastPointSchema>;

export const FORECAST_INSUFFICIENT_REASONS = [
  'not_forecastable',
  'too_few_points',
  'span_too_short',
] as const;

/**
 * 预测结果（forecastMetric 的输出，也是 twin_forecasts 一行的内容）。
 * 数据不足时 status = insufficient_data，points 为空，给出原因和“还需要 x 次数据”。
 */
export const forecastResultSchema = z.object({
  metric: z.string(),
  source: twinRuleSourceSchema,
  methodVersion: z.string(),
  intervalLevel: z.number(),
  status: z.enum(['ok', 'insufficient_data']),
  insufficientReason: z.enum(FORECAST_INSUFFICIENT_REASONS).nullable(),
  /** 还需要几次数据（报告次数或有效周数）；跨度不够时为空 */
  pointsNeeded: z.number().int().positive().nullable(),
  /** 用了几次数据（报告次数或有效周数） */
  nPoints: z.number().int().nonnegative(),
  spanDays: z.number().int().nonnegative(),
  horizonMonths: z.union([z.literal(3), z.literal(6)]).nullable(),
  uncertainty: z.enum(['normal', 'high']).nullable(),
  basis: z
    .object({
      kind: z.enum(['report_values', 'weekly_averages']),
      from: z.iso.date(),
      to: z.iso.date(),
      /** 预测从这一天起算 */
      anchor: z.iso.date(),
    })
    .nullable(),
  /** 拟合参数，偏离判断用（6.4）。不给前端展示 */
  fit: z
    .object({
      origin: z.iso.date(),
      originAt: z.iso.datetime(),
      n: z.number().int(),
      intercept: z.number(),
      slopePerDay: z.number(),
      meanX: z.number(),
      sxx: z.number(),
      residualSd: z.number(),
    })
    .nullable(),
  points: z.array(forecastPointSchema),
});
export type ForecastResult = z.infer<typeof forecastResultSchema>;

/** 接口返回的一条预测（不含拟合参数） */
export const twinForecastSchema = forecastResultSchema.omit({ fit: true }).extend({
  id: z.uuid(),
  computedAt: z.iso.datetime(),
});
export type TwinForecast = z.infer<typeof twinForecastSchema>;

/** 大图：历次实际数值 + 最新预测 */
export const twinForecastDetailResponseSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  actual: z.array(
    z.object({
      at: z.iso.datetime(),
      value: z.number(),
      source: twinRuleSourceSchema,
      /** 手动录入的监测读数标“手动” */
      manual: z.boolean(),
    }),
  ),
  forecasts: z.array(twinForecastSchema),
  /** 最近一份报告上印的参考范围（不同报告范围不同时用最近一份） */
  reference: z.object({ low: z.number().nullable(), high: z.number().nullable() }).nullable(),
});
export type TwinForecastDetailResponse = z.infer<typeof twinForecastDetailResponseSchema>;

// ---------- @ 引用孪生项（2.8） ----------

export const twinRefSchema = z.object({
  kind: z.enum(['domain', 'metric']),
  code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
});
export type TwinRef = z.infer<typeof twinRefSchema>;
export const TWIN_REFS_MAX = 3;

/**
 * 孪生项的编码在目录里（2.8）：方面只能是四个方面之一，指标只能是做预测的指标（FORECAST_METRICS）。
 * 客户归属由后端在发消息时重新校验，不在这里判断。
 */
export function isKnownTwinRef(ref: TwinRef): boolean {
  return ref.kind === 'domain'
    ? (TWIN_DOMAINS as readonly string[]).includes(ref.code)
    : (FORECAST_METRICS as readonly string[]).includes(ref.code);
}

/** 同一个孪生项的键（去重用） */
export function twinRefKey(ref: TwinRef): string {
  return `${ref.kind}:${ref.code}`;
}

/**
 * “请专家看看”（2.6 之二）没有补充问题时，后端用这句话当作健管师的问题。
 * 健管师没补充问题文字时，路由只按规则命中（不用模型补充，2.6 之二第 4 条）。
 */
export const TWIN_CONSULT_DEFAULT_REQUEST = '请专家看看';

// ---------- 时间轴（2.5） ----------

export const TWIN_TIMELINE_TYPES = [
  'report',
  'monitoring_alert',
  'correction',
  'health_history',
  'risk_tier',
  'status_change',
  'follow_up',
  'expert',
  'artifact',
  // M5 规格 2.6、6.2：方案生效 / 结束 / 被替代，随访完成 / 未联系上 / 取消，随访记录确认
  'care_plan',
  'visit',
  'visit_record',
] as const;
export const twinTimelineTypeSchema = z.enum(TWIN_TIMELINE_TYPES);
export type TwinTimelineType = z.infer<typeof twinTimelineTypeSchema>;

/** 机构管理员能看的时间轴类型（Q20：只看基于已核对数据的事件） */
export const TWIN_TIMELINE_ORG_ADMIN_TYPES = [
  'report',
  'monitoring_alert',
  'correction',
  'health_history',
  'risk_tier',
  'status_change',
] as const satisfies readonly TwinTimelineType[];

export const twinTimelineQuerySchema = z.object({
  /** 分页：只返回早于这个时间的事件 */
  before: z.iso.datetime().optional(),
  types: z.array(twinTimelineTypeSchema).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TwinTimelineQuery = z.infer<typeof twinTimelineQuerySchema>;

const timelineBase = { id: z.string(), at: z.iso.datetime() };

export const twinTimelineEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...timelineBase,
    type: z.literal('report'),
    reportId: z.uuid(),
    reportDate: z.iso.date(),
    abnormalCount: z.number().int().nonnegative(),
    hasCritical: z.boolean(),
  }),
  z.object({
    ...timelineBase,
    type: z.literal('monitoring_alert'),
    metric: z.string(),
    date: z.iso.date(),
    method: twinRuleMethodSchema,
    level: twinRuleLevelSchema,
  }),
  // 报告更正：哪一项、谁、何时，不显示数值
  z.object({
    ...timelineBase,
    type: z.literal('correction'),
    reportId: z.uuid(),
    metric: z.string().nullable(),
    actorName: z.string().nullable(),
  }),
  z.object({
    ...timelineBase,
    type: z.literal('health_history'),
    category: z.enum(['past_history', 'family_history', 'medication', 'allergy', 'lifestyle']),
    summary: z.string(),
    action: z.enum(['created', 'updated']),
  }),
  z.object({
    ...timelineBase,
    type: z.literal('risk_tier'),
    tier: riskTierRecordSchema.shape.tier,
    reason: z.string(),
    setByName: z.string().nullable(),
  }),
  z.object({
    ...timelineBase,
    type: z.literal('status_change'),
    domain: twinDomainSchema,
    from: twinLevelSchema.nullable(),
    to: twinLevelSchema,
    origin: twinStatusOriginSchema,
    trigger: twinStatusTriggerSchema,
  }),
  z.object({
    ...timelineBase,
    type: z.literal('follow_up'),
    itemId: z.uuid(),
    kind: z.enum(['critical', 'status_red', 'status_worsened', 'forecast_deviation']),
    action: z.enum(['created', 'done', 'snoozed', 'dismissed', 'reopened']),
    resolution: z.string().nullable(),
    dismissReason: z.string().nullable(),
  }),
  z.object({
    ...timelineBase,
    type: z.literal('expert'),
    consultationId: z.uuid(),
    taskId: z.uuid(),
    trigger: z.string(),
    expertIds: z.array(z.string()),
  }),
  // 产物：确认、复制、导出，不显示内容
  z.object({
    ...timelineBase,
    type: z.literal('artifact'),
    artifactId: z.uuid(),
    taskId: z.uuid(),
    kind: z.string(),
    action: z.enum(['approved', 'copied', 'exported']),
  }),
  // 方案：只显示部分和原因，不显示方案文字
  z.object({
    ...timelineBase,
    type: z.literal('care_plan'),
    planId: z.uuid(),
    action: z.enum(['activated', 'ended', 'superseded']),
    sections: z.array(planSectionSchema),
    endReason: carePlanEndReasonSchema.nullable(),
  }),
  // 随访处理：不显示重点和备注
  z.object({
    ...timelineBase,
    type: z.literal('visit'),
    visitId: z.uuid(),
    action: z.enum(['done', 'missed', 'cancelled']),
    method: visitMethodSchema,
    purpose: visitPurposeSchema,
  }),
  // 随访记录确认：日期、方式和摘要的前 50 字，点开跳到记录
  z.object({
    ...timelineBase,
    type: z.literal('visit_record'),
    recordId: z.uuid(),
    visitDate: z.iso.date(),
    method: visitMethodSchema,
    excerpt: z.string(),
  }),
]);
export type TwinTimelineEvent = z.infer<typeof twinTimelineEventSchema>;

export const twinTimelineResponseSchema = z.object({
  events: z.array(twinTimelineEventSchema),
  /** 还有更早的事件时，下一页的 before */
  nextBefore: z.iso.datetime().nullable(),
});
export type TwinTimelineResponse = z.infer<typeof twinTimelineResponseSchema>;

// ---------- 孪生主视图 ----------

/** 健管师看到的孪生 */
export const twinResponseSchema = z.object({
  client: clientSummarySchema,
  domains: z.array(twinDomainViewSchema),
  /** 当前分层，只读（Q21：和红黄绿相互独立） */
  riskTier: riskTierRecordSchema.nullable(),
  forecasts: z.array(twinForecastSchema),
  openFollowUpCount: z.number().int().nonnegative(),
  /** 有未处理的危急指标跟进项：顶部提示条变醒目 */
  hasOpenCritical: z.boolean(),
  /** 队列还没算完：显示“正在更新”和上一次的结果 */
  computing: z.boolean(),
  /** 还没有任何已核对报告和监测数据（空状态） */
  hasData: z.boolean(),
});
export type TwinResponse = z.infer<typeof twinResponseSchema>;

/**
 * 机构管理员看到的孪生（Q20）：只读画像、状态（含依据）。
 * 用单独的 schema（字段更少），不是在同一 schema 里置空，避免以后加字段时漏掉过滤。
 */
export const twinOrgAdminResponseSchema = z.object({
  client: clientSummarySchema,
  domains: z.array(twinDomainViewSchema),
  riskTier: riskTierRecordSchema.nullable(),
  hasData: z.boolean(),
});
export type TwinOrgAdminResponse = z.infer<typeof twinOrgAdminResponseSchema>;

/** 手动调整、取消调整后返回这个方面的最新状态 */
export const twinDomainResponseSchema = z.object({ domain: twinDomainViewSchema });
export type TwinDomainResponse = z.infer<typeof twinDomainResponseSchema>;

// ---------- 左侧栏客户列表的状态圆点（2.1） ----------

/**
 * 当前健管师每位客户的整体状态：四个方面里最严重的那个（红 > 黄 > 绿 > 灰，worstTwinLevel），
 * 有效的手动调整优先。只有颜色等级，不含依据和数值。只给健管师。
 */
export const twinClientLevelSchema = z.object({
  clientId: z.uuid(),
  level: twinLevelSchema,
});
export type TwinClientLevel = z.infer<typeof twinClientLevelSchema>;

export const twinLevelsResponseSchema = z.object({ clients: z.array(twinClientLevelSchema) });
export type TwinLevelsResponse = z.infer<typeof twinLevelsResponseSchema>;
