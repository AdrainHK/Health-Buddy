import type { ClientSummary, Task } from '@health-buddy/shared';

export type TaskGroupKind = 'client' | 'unlinked' | 'detached';

export interface TaskGroup {
  key: string;
  kind: TaskGroupKind;
  /** kind 为 client 时是客户姓名 */
  clientName?: string;
  tasks: Task[];
}

export const isReadOnlyTask = (task: Task): boolean => task.detachedReason !== null;

/**
 * 任务按客户分组（客户即工作空间）。
 * - 关联了自己客户的任务归到该客户下；
 * - 没有关联客户的放在“未关联客户”；
 * - 客户已转出或删除（任务只读，或客户已不在自己的列表里）的放在“已转出或删除的客户”。
 * 组内和组之间都按最近更新排序。
 */
export function groupTasks(
  tasks: readonly Task[],
  /** null 表示客户列表还没加载出来，此时不把任务判为“已转出” */
  clients: readonly ClientSummary[] | null,
): TaskGroup[] {
  const names = new Map((clients ?? []).map((c) => [c.id, c.displayName]));
  const sorted = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = new Map<string, TaskGroup>();
  for (const task of sorted) {
    const name = task.clientId ? names.get(task.clientId) : undefined;
    let group: Omit<TaskGroup, 'tasks'>;
    if (isReadOnlyTask(task) || (task.clientId && clients && name === undefined)) {
      group = { key: 'detached', kind: 'detached' };
    } else if (task.clientId) {
      group = {
        key: `client:${task.clientId}`,
        kind: 'client',
        ...(name !== undefined ? { clientName: name } : {}),
      };
    } else {
      group = { key: 'unlinked', kind: 'unlinked' };
    }
    const existing = groups.get(group.key);
    if (existing) existing.tasks.push(task);
    else groups.set(group.key, { ...group, tasks: [task] });
  }
  // Map 保持插入顺序，第一个任务最新，所以组也按最近更新排好了
  return [...groups.values()];
}
