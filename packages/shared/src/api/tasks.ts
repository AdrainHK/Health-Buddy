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
  ]),
  labelKey: z.string(),
  /** 步骤文案参数：涉及的专家 id（如“已调用：内分泌与代谢专家、营养专家”） */
  expertIds: z.array(expertIdSchema).default([]),
  /** 步骤涉及的报告日期，如“正在读取报告（2026-09-12）”（M2 规格 2.6） */
  labelDate: z.iso.date().nullable().default(null),
  /** 步骤涉及的时间，如“沿用 10:32 的专家意见”（M3 规格 3.7），界面按本地时区显示 */
  labelTime: z.iso.datetime().nullable().default(null),
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
  })
  // 问一问不能调用技能（Q4），前端会先提示切换模式
  .refine((v) => !(v.mode === 'ask' && v.skillId !== undefined), {
    message: 'skills are not available in ask mode',
    path: ['skillId'],
  })
  // 没有技能时必须有内容
  .refine((v) => v.content.length > 0 || v.skillId !== undefined, {
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
