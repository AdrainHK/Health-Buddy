import {
  clientListResponseSchema,
  skillListResponseSchema,
  taskDetailResponseSchema,
  taskListResponseSchema,
  taskSchema,
  type ClientSummary,
  type CreateTaskRequest,
  type SkillSummary,
  type Task,
  type TaskDetailResponse,
  type UpdateTaskRequest,
} from '@health-buddy/shared';
import { z } from 'zod';
import { apiRequest } from './http';

// 新建和修改任务的响应是 { task }，用 shared 的 taskSchema 校验
const taskResponseSchema = z.object({ task: taskSchema });
const stopResponseSchema = z.object({ stopped: z.boolean() });

/** 当前健管师的任务列表。archived 为 true 时只列已归档的任务。 */
export async function listTasks(options: { archived?: boolean } = {}): Promise<Task[]> {
  const query = options.archived ? '?archived=true' : '';
  const { tasks } = await apiRequest(`/tasks${query}`, taskListResponseSchema);
  return tasks;
}

export async function createTask(body: CreateTaskRequest = {}): Promise<Task> {
  const { task } = await apiRequest('/tasks', taskResponseSchema, { method: 'POST', body });
  return task;
}

/** 重命名、归档、取消归档 */
export async function updateTask(id: string, body: UpdateTaskRequest): Promise<Task> {
  const { task } = await apiRequest(`/tasks/${id}`, taskResponseSchema, {
    method: 'PATCH',
    body,
  });
  return task;
}

/** 任务详情：消息、步骤、计划和产物摘要 */
export function getTask(id: string, signal?: AbortSignal): Promise<TaskDetailResponse> {
  return apiRequest(`/tasks/${id}`, taskDetailResponseSchema, signal ? { signal } : {});
}

/** 停止当前生成。返回服务端是否真的停下了一个正在进行的生成。 */
export async function stopTask(id: string): Promise<boolean> {
  const { stopped } = await apiRequest(`/tasks/${id}/stop`, stopResponseSchema, {
    method: 'POST',
  });
  return stopped;
}

export async function listSkills(): Promise<SkillSummary[]> {
  const { skills } = await apiRequest('/skills', skillListResponseSchema);
  return skills;
}

/** 当前健管师自己的客户（后端受行级安全约束） */
export async function listClients(): Promise<ClientSummary[]> {
  const { clients } = await apiRequest('/clients', clientListResponseSchema);
  return clients;
}
