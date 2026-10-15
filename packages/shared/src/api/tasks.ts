import { z } from 'zod';
import { artifactSummarySchema } from './artifacts.js';

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
  status: messageStatusSchema,
  createdAt: z.iso.datetime(),
});
export type TaskMessage = z.infer<typeof taskMessageSchema>;

/** 执行步骤。labelKey 是 i18n 键，不带自由文本。 */
export const taskStepSchema = z.object({
  id: z.uuid(),
  messageId: z.uuid(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(['read_client', 'detect_critical', 'run_skill', 'answer']),
  labelKey: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TaskStep = z.infer<typeof taskStepSchema>;

/** 想一想模式的计划。M1 只有两种步骤（规格 3.3）。 */
export const planStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read_client') }),
  z.object({ kind: z.literal('run_skill'), skillId: z.string().min(1) }),
]);
export type PlanStep = z.infer<typeof planStepSchema>;

export const taskPlanSchema = z.object({
  id: z.uuid(),
  messageId: z.uuid(),
  steps: z.array(planStepSchema).min(1),
  status: z.enum(['proposed', 'confirmed', 'revised']),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;

export const taskDetailResponseSchema = z.object({
  task: taskSchema,
  messages: z.array(taskMessageSchema),
  steps: z.array(taskStepSchema),
  plans: z.array(taskPlanSchema),
  artifacts: z.array(artifactSummarySchema),
});
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

export const sendMessageRequestSchema = z
  .object({
    mode: taskModeSchema,
    content: z.string().trim().min(1).max(MESSAGE_CONTENT_MAX),
    skillId: z.string().min(1).optional(),
    /** 每个任务只关联一位客户（Q6） */
    clientRefs: z.array(z.uuid()).max(1).default([]),
  })
  // 问一问不能调用技能（Q4），前端会先提示切换模式
  .refine((v) => !(v.mode === 'ask' && v.skillId !== undefined), {
    message: 'skills are not available in ask mode',
    path: ['skillId'],
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
]);
export type TaskStreamEvent = z.infer<typeof taskStreamEventSchema>;
