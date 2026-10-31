import { z } from 'zod';
import { artifactSummarySchema } from './artifacts.js';
import {
  consultationEventSchema,
  expertCallEventSchema,
  expertSuggestionEventSchema,
  expertIdSchema,
  EXPERTS_PER_CALL_MAX,
} from './experts.js';
import { reportUploadSummarySchema } from './reports.js';
import { TWIN_REFS_MAX, twinRefKey, twinRefSchema } from './twin.js';
import { planOptionsSchema } from './care-plans.js';
import { libraryItemTypeSchema } from '../plan/library.js';
import { VISIT_MATERIALS_PER_RECORD_MAX } from './visits.js';

/** 三种工作模式：问一问、想一想、做一做（M1 规格 3.3） */
export const TASK_MODES = ['ask', 'plan', 'craft'] as const;
export const taskModeSchema = z.enum(TASK_MODES);
export type TaskMode = z.infer<typeof taskModeSchema>;

/** 客户转出或删除后，任务与客户断开关联的原因（Q11） */
export const taskDetachedReasonSchema = z.enum(['client_transferred', 'client_deleted']);
export type TaskDetachedReason = z.infer<typeof taskDetachedReasonSchema>;

export const taskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  clientId: z.uuid().nullable(),
  archived: z.boolean(),
  /** 不为空时任务只读 */
  detachedReason: taskDetachedReasonSchema.nullable(),
  /** 专家中心发起的任务绑定的专家（M3 规格 2.3）；普通任务为空 */
  expertId: expertIdSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;

export const TASK_TITLE_MAX = 100;
/** 单条消息上限，防止把整份档案粘进来 */
export const MESSAGE_CONTENT_MAX = 4000;

export const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
  clientId: z.uuid().optional(),
  /** 从专家中心新建绑定专家的任务（M3 规格 2.3）；专家对当前账号不可用时 404 */
  expertId: expertIdSchema.optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.archived !== undefined, {
    message: 'nothing to update',
  });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const listTasksQuerySchema = z.object({
  clientId: z.uuid().optional(),
  archived: z.enum(['true', 'false']).optional(),
});

export const taskListResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

export const messageStatusSchema = z.enum(['streaming', 'complete', 'stopped', 'refused', 'error']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** @ 引用的伴侣转交最多 1 个（M6 规格 2.8） */
export const HANDOFF_REFS_MAX = 1;

/** @ 引用的库条目：食谱、运动和放松练习（只能引用已发布的条目，后端再校验） */
export const LIBRARY_REFS_MAX = 3;
export const libraryRefSchema = z.object({
  type: libraryItemTypeSchema.exclude(['goal_template']),
  id: z.uuid(),
});
export type LibraryRef = z.infer<typeof libraryRefSchema>;

export const taskMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['manager', 'assistant']),
  mode: taskModeSchema,
  content: z.string(),
  skillId: z.string().nullable(),
  clientRefs: z.array(z.uuid()),
  /** @ 引用的已核对报告（M2 规格 2.6） */
  reportRefs: z.array(z.uuid()).default([]),
  /** @ 的专家（M3 规格 2.4） */
  expertRefs: z.array(expertIdSchema).default([]),
  /** “不要请”的专家（M3 规格 2.5） */
  excludedExperts: z.array(expertIdSchema).default([]),
  /** @ 引用的孪生项（M4 规格 2.8），最多 3 个 */
  twinRefs: z.array(twinRefSchema).default([]),
  /** @ 引用的库条目（M5 规格 2.1），最多 3 个 */
  libraryRefs: z.array(libraryRefSchema).default([]),
  /** @ 引用的随访素材（M5 规格 2.9），最多 3 份 */
  materialRefs: z.array(z.uuid()).default([]),
  /** @ 引用的伴侣转交（M6 规格 2.8，/转交回复），最多 1 个 */
  handoffRefs: z.array(z.uuid()).default([]),
  /** /方案生成 的选项 */
  planOptions: planOptionsSchema.nullable().default(null),
  status: messageStatusSchema,
  createdAt: z.iso.datetime(),
});
export type TaskMessage = z.infer<typeof taskMessageSchema>;

/** 执行步骤。labelKey 是 i18n 键，不带自由文本。 */
export const taskStepSchema = z.object({
  id: z.uuid(),
  messageId: z.uuid(),
  seq: z.number().int().nonnegative(),
  kind: z.enum([
    'read_client',
    'read_report',
    'compare_reports',
    'detect_critical',
    'run_skill',
    'answer',
    // M3 规格 2.6：选择专家、调用专家（多位）、调用单位专家、汇总
    'route_experts',
    'consult_experts',
    'consult_expert',
    'synthesize_experts',
    // M4 规格 2.7、2.9：正在读取数字孪生、正在计算趋势
    'read_twin',
    'compute_forecast',
    // M5 规格 2.1：正在读取当前方案、正在选择食谱和动作、正在排随访日期、正在读取随访素材、正在读取随访记录
    'read_care_plan',
    'select_library_items',
    'schedule_visits',
    'read_visit_materials',
    'read_visit_records',
    // M6 规格 2.8：正在读取伴侣信息
    'read_companion',
  ]),
  labelKey: z.string(),
  /** 步骤文案参数：涉及的专家 id（如“已调用：内分泌与代谢专家、营养专家”） */
  expertIds: z.array(expertIdSchema).default([]),
  /** 步骤涉及的报告日期，如“正在读取报告（2026-09-12）”（M2 规格 2.6） */
  labelDate: z.iso.date().nullable().default(null),
  /** 步骤涉及的时间，如“沿用 10:32 的专家意见”（M3 规格 3.7），界面按本地时区显示 */
  labelTime: z.iso.datetime().nullable().default(null),
  /**
   * 10 分钟内沿用上次意见的步骤：被沿用的那次调用（规格 3.7）。对话区刷新后据此恢复危机、急症提示
   */
  consultationId: z.uuid().nullable().default(null),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskStep = z.infer<typeof taskStepSchema>;

/**
 * 想一想模式的计划（M1 规格 3.3）。M2 起一份计划可以按顺序调用多个技能（Q22），
 * 如“新客户完整评估”= 读档案 → /体检解读 → /面谈提纲，每个技能各出一份草稿。
 */
export const PLAN_STEPS_MAX = 6;

export const planStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read_client') }),
  // M4“孪生复盘”：读取客户档案 → 读取数字孪生 → /孪生小结
  z.object({ kind: z.literal('read_twin') }),
  // M6“伴侣跟进”：读取客户档案 → 读取伴侣信息 → /随访话术
  z.object({ kind: z.literal('read_companion') }),
  z.object({ kind: z.literal('run_skill'), skillId: z.string().min(1) }),
]);
export type PlanStep = z.infer<typeof planStepSchema>;

export const taskPlanSchema = z.object({
  id: z.uuid(),
  messageId: z.uuid(),
  steps: z.array(planStepSchema).min(1).max(PLAN_STEPS_MAX),
  status: z.enum(['proposed', 'confirmed', 'revised']),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;

export const taskDetailResponseSchema = z.object({
  task: taskSchema,
  messages: z.array(taskMessageSchema),
  steps: z.array(taskStepSchema),
  plans: z.array(taskPlanSchema),
  artifacts: z.array(artifactSummarySchema),
  /** 在这个任务里上传的报告（对话区的识别卡片，M2 规格 2.1） */
  uploads: z.array(reportUploadSummarySchema).default([]),
});
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

export const sendMessageRequestSchema = z
  .object({
    mode: taskModeSchema,
    /** 可以为空，但只限不需要再写要求的技能（后端按技能元数据校验，用默认要求文字） */
    content: z.string().trim().max(MESSAGE_CONTENT_MAX).default(''),
    skillId: z.string().min(1).optional(),
    /** 每个任务只关联一位客户（Q6） */
    clientRefs: z.array(z.uuid()).max(1).default([]),
    /** @ 引用的已核对报告，最多 1 份，必须属于任务关联的客户（M2 规格 2.6） */
    reportRefs: z.array(z.uuid()).max(1).default([]),
    /** @ 的专家，最多 3 位（M3 Q5）；后端重新校验专家对当前账号可用 */
    expertRefs: z.array(expertIdSchema).max(EXPERTS_PER_CALL_MAX).default([]),
    /** “不要请”的专家，只对这一条消息生效（M3 Q22） */
    excludedExperts: z.array(expertIdSchema).max(20).default([]),
    /**
     * @ 引用的孪生项（M4 规格 2.8），最多 3 个，只能在问一问里用；后端重新校验任务关联的客户
     * 属于当前健管师、编码在目录里，否则 404，不调用任何模型
     */
    twinRefs: z.array(twinRefSchema).max(TWIN_REFS_MAX).default([]),
    /**
     * “请专家看看”（M4 规格 2.6 之二）：按孪生项涉及的指标自动选专家。只能在问一问里、带孪生项；
     * 内容可以为空（后端用 TWIN_CONSULT_DEFAULT_REQUEST）
     */
    twinConsult: z.boolean().default(false),
    /** 从跟进项发起的“请专家看看”：必须是任务关联客户的跟进项，否则 404 */
    followUpItemId: z.uuid().optional(),
    /** @ 引用的库条目（M5 规格 2.1），最多 3 个 */
    libraryRefs: z.array(libraryRefSchema).max(LIBRARY_REFS_MAX).default([]),
    /**
     * @ 引用的随访素材（/随访记录），最多 3 份，必须属于任务关联的客户、由当前健管师上传；
     * 否则 404，不调用任何模型
     */
    materialRefs: z.array(z.uuid()).max(VISIT_MATERIALS_PER_RECORD_MAX).default([]),
    /**
     * @ 引用的伴侣转交（/转交回复，M6 规格 2.8），最多 1 个，必须是任务关联客户的、服务这位客户的健管师的
     * 未处理转交；否则 404，不调用任何模型
     */
    handoffRefs: z.array(z.uuid()).max(HANDOFF_REFS_MAX).default([]),
    /** /方案生成、“方案和随访”计划的选项 */
    planOptions: planOptionsSchema.optional(),
    /** 关联的那一次随访（“准备随访”“记录随访”），必须是任务关联客户的随访 */
    visitId: z.uuid().optional(),
  })
  // 问一问不能调用技能（Q4），前端会先提示切换模式
  .refine((v) => !(v.mode === 'ask' && v.skillId !== undefined), {
    message: 'skills are not available in ask mode',
    path: ['skillId'],
  })
  // 没有技能时必须有内容（“请专家看看”可以不写，后端用默认的问题）
  .refine((v) => v.content.length > 0 || v.skillId !== undefined || v.twinConsult, {
    message: 'content is required without a skill',
    path: ['content'],
  })
  .refine((v) => new Set(v.expertRefs).size === v.expertRefs.length, {
    message: 'duplicate expert',
    path: ['expertRefs'],
  })
  // 同一位专家不能既要请又不要请
  .refine((v) => !v.expertRefs.some((e) => v.excludedExperts.includes(e)), {
    message: 'expert both requested and excluded',
    path: ['excludedExperts'],
  })
  // 孪生项只能在问一问里引用（2.8、2.9），不能重复
  .refine((v) => v.twinRefs.length === 0 || (v.mode === 'ask' && v.skillId === undefined), {
    message: 'twin refs are only available in ask mode',
    path: ['twinRefs'],
  })
  .refine((v) => new Set(v.twinRefs.map(twinRefKey)).size === v.twinRefs.length, {
    message: 'duplicate twin ref',
    path: ['twinRefs'],
  })
  // “请专家看看”必须带孪生项；跟进项只能随“请专家看看”一起
  .refine((v) => !v.twinConsult || v.twinRefs.length > 0, {
    message: 'twin consult needs a twin ref',
    path: ['twinConsult'],
  })
  .refine((v) => v.followUpItemId === undefined || v.twinConsult, {
    message: 'follow-up item only with twin consult',
    path: ['followUpItemId'],
  })
  // 库条目只能在问一问里直接提问时引用（M5 规格 2.11：回答读取这个条目）；
  // 请专家的问一问不读库条目，不能一起用
  .refine(
    (v) =>
      v.libraryRefs.length === 0 ||
      (v.mode === 'ask' && v.skillId === undefined && !v.twinConsult && v.expertRefs.length === 0),
    { message: 'library refs are only available in plain ask', path: ['libraryRefs'] },
  )
  .refine((v) => new Set(v.libraryRefs.map((r) => r.id)).size === v.libraryRefs.length, {
    message: 'duplicate library ref',
    path: ['libraryRefs'],
  })
  .refine((v) => new Set(v.materialRefs).size === v.materialRefs.length, {
    message: 'duplicate material ref',
    path: ['materialRefs'],
  })
  // 素材只能交给技能整理（/随访记录），不能在问一问里引用
  .refine((v) => v.materialRefs.length === 0 || v.skillId !== undefined, {
    message: 'material refs need a skill',
    path: ['materialRefs'],
  })
  // 转交只能交给技能起草回复（/转交回复），不能在问一问里引用
  .refine((v) => v.handoffRefs.length === 0 || v.skillId !== undefined, {
    message: 'handoff refs need a skill',
    path: ['handoffRefs'],
  });
export type SendMessageRequest = z.input<typeof sendMessageRequestSchema>;

/** 流结束的原因 */
export const doneReasonSchema = z.enum(['complete', 'stopped', 'refused', 'error']);

/** SSE 错误只带类别，不带厂商原始信息 */
export const streamErrorKindSchema = z.enum([
  'not_configured',
  'rate_limited',
  'timeout',
  'provider_error',
  'invalid_output',
  /** 输出两次都没通过保存前的措辞检查（/面谈提纲：禁用词、疾病名称），没有保存草稿 */
  'wording_check_failed',
  /** 套餐的本月额度用完（M7 规格 2.5）：没有调用模型；危机、急症信号时不受限制 */
  'quota_exceeded',
  'internal_error',
]);

/** POST /api/tasks/:id/messages 推送的事件（规格 3.2） */
export const taskStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: taskStepSchema }),
  z.object({ type: z.literal('text'), messageId: z.uuid(), delta: z.string() }),
  z.object({ type: z.literal('plan'), plan: taskPlanSchema }),
  z.object({ type: z.literal('artifact'), artifact: artifactSummarySchema }),
  /** 自然语言里识别到技能意图时，只建议，不执行（Q5） */
  z.object({ type: z.literal('suggestion'), skillId: z.string() }),
  z.object({ type: z.literal('done'), messageId: z.uuid(), reason: doneReasonSchema }),
  z.object({ type: z.literal('error'), kind: streamErrorKindSchema }),
  // M3：每位专家的状态、一次专家调用结束（规格 6.3）
  expertCallEventSchema,
  consultationEventSchema,
  expertSuggestionEventSchema,
]);
export type TaskStreamEvent = z.infer<typeof taskStreamEventSchema>;
