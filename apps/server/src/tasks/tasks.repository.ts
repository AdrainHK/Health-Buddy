import { Inject, Injectable } from '@nestjs/common';
import type {
  ArtifactSummary,
  CreateTaskRequest,
  PlanStep,
  Task,
  TaskDetailResponse,
  TaskMessage,
  TaskPlan,
  TaskStep,
  UpdateTaskRequest,
} from '@health-buddy/shared';
import { conflict } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

/** 健管师没给标题时的默认标题，第一次发消息后前端可以改名 */
export const DEFAULT_TASK_TITLE = '新任务';

export type TaskLookup = 'missing' | Task;

/**
 * 任务仓储。任务只对健管师本人可见（行级安全），这里不再额外判断归属：
 * 查不到就是不存在，或者不属于当前健管师。
 */
@Injectable()
export class TasksRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** clientId 不是当前健管师的客户时返回 undefined（接口按 404 处理） */
  list(
    ctx: TenantContext,
    filter: { clientId?: string | undefined; archived: boolean },
  ): Promise<Task[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (filter.clientId && !(await clientVisible(trx, filter.clientId))) return undefined;
      let q = selectTask(trx)
        .where('archived_at', filter.archived ? 'is not' : 'is', null)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .limit(500);
      if (filter.clientId) q = q.where('client_id', '=', filter.clientId);
      return (await q.execute()).map(toTask);
    });
  }

  /** clientId 不是当前健管师的客户时返回 undefined */
  create(ctx: TenantContext, input: CreateTaskRequest): Promise<Task | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (input.clientId && !(await clientVisible(trx, input.clientId))) return undefined;
      const row = await trx
        .insertInto('tasks')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: input.clientId ?? null,
          title: input.title ?? DEFAULT_TASK_TITLE,
          archived_at: null,
        })
        .returning(TASK_COLUMNS)
        .executeTakeFirstOrThrow();
      return toTask(row);
    });
  }

  /** 找不到返回 undefined；只读任务（客户已转出或删除）抛 409 */
  update(ctx: TenantContext, id: string, input: UpdateTaskRequest): Promise<Task | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const current = await selectTask(trx).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) return undefined;
      if (current.detached_reason) throw conflict({ reasons: ['read_only'] });
      const row = await trx
        .updateTable('tasks')
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.archived !== undefined
            ? { archived_at: input.archived ? (current.archived_at ?? new Date()) : null }
            : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returning(TASK_COLUMNS)
        .executeTakeFirstOrThrow();
      return toTask(row);
    });
  }

  detail(ctx: TenantContext, id: string): Promise<TaskDetailResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const task = await selectTask(trx).where('id', '=', id).executeTakeFirst();
      if (!task) return undefined;
      const messages = await trx
        .selectFrom('task_messages')
        .select([
          'id',
          'role',
          'mode',
          'content',
          'skill_id',
          'client_refs',
          'status',
          'created_at',
        ])
        .where('task_id', '=', id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const messageIds = messages.map((m) => m.id);
      const steps = messageIds.length
        ? await trx
            .selectFrom('task_steps')
            .select([
              'id',
              'message_id',
              'seq',
              'kind',
              'label_key',
              'status',
              'started_at',
              'finished_at',
            ])
            .where('message_id', 'in', messageIds)
            .orderBy('started_at')
            .orderBy('seq')
            .execute()
        : [];
      const plans = messageIds.length
        ? await trx
            .selectFrom('task_plans')
            .select(['id', 'message_id', 'steps', 'status'])
            .where('message_id', 'in', messageIds)
            .orderBy('created_at')
            .execute()
        : [];
      const artifacts = await selectArtifactSummary(trx)
        .where('task_id', '=', id)
        .orderBy('created_at')
        .orderBy('version')
        .execute();
      return {
        task: toTask(task),
        messages: messages.map((m): TaskMessage => ({
          id: m.id,
          role: m.role,
          mode: m.mode,
          content: m.content,
          skillId: m.skill_id,
          clientRefs: m.client_refs,
          status: m.status,
          createdAt: m.created_at.toISOString(),
        })),
        steps: steps.map((s): TaskStep => ({
          id: s.id,
          messageId: s.message_id,
          seq: s.seq,
          kind: s.kind,
          labelKey: s.label_key,
          status: s.status,
          startedAt: s.started_at.toISOString(),
          finishedAt: s.finished_at?.toISOString() ?? null,
        })),
        plans: plans.map((p): TaskPlan => ({
          id: p.id,
          messageId: p.message_id,
          steps: p.steps as PlanStep[],
          status: p.status,
        })),
        artifacts: artifacts.map(toArtifactSummary),
      };
    });
  }
}

const TASK_COLUMNS = [
  'id',
  'title',
  'client_id',
  'archived_at',
  'detached_reason',
  'created_at',
  'updated_at',
] as const;

function selectTask(trx: TenantTransaction) {
  return trx.selectFrom('tasks').select(TASK_COLUMNS);
}

/** 客户是否对当前账号可见（客户表的行级安全决定） */
export async function clientVisible(trx: TenantTransaction, clientId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .executeTakeFirst();
  return Boolean(row);
}

function toTask(row: {
  id: string;
  title: string;
  client_id: string | null;
  archived_at: Date | null;
  detached_reason: Task['detachedReason'];
  created_at: Date;
  updated_at: Date;
}): Task {
  return {
    id: row.id,
    title: row.title,
    clientId: row.client_id,
    archived: row.archived_at !== null,
    detachedReason: row.detached_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function selectArtifactSummary(trx: TenantTransaction) {
  return trx
    .selectFrom('artifacts')
    .select(['id', 'task_id', 'skill_id', 'version', 'status', 'critical_flags', 'created_at']);
}

export function toArtifactSummary(row: {
  id: string;
  task_id: string;
  skill_id: string;
  version: number;
  status: ArtifactSummary['status'];
  critical_flags: unknown[];
  created_at: Date;
}): ArtifactSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    skillId: row.skill_id,
    version: row.version,
    status: row.status,
    hasCriticalFlags: row.critical_flags.length > 0,
    createdAt: row.created_at.toISOString(),
  };
}
