import { Inject, Injectable } from '@nestjs/common';
import {
  TWIN_CONSULT_DEFAULT_REQUEST,
  type ArtifactSummary,
  type CreateTaskRequest,
  type PlanStep,
  type Task,
  type TaskDetailResponse,
  type TaskMessage,
  type TaskPlan,
  type TaskStep,
  type UpdateTaskRequest,
} from '@health-buddy/shared';
import { conflict } from '../common/api-error.js';
import { selectUploadSummary, toUploadSummary } from '../reports/reports.repository.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type { TaskTitleSource } from '../db/types.js';
import { buildTaskTitle, type TitleTurn } from './task-title.js';

/** 健管师没给标题时的默认标题，第一次发消息时换成按这一轮生成的标题（见 task-title.ts） */
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
      return (await backfillTitles(trx, await q.execute())).map(toTask);
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
          expert_id: input.expertId ?? null,
          title: input.title ?? DEFAULT_TASK_TITLE,
          title_source: input.title !== undefined ? 'manual' : 'default',
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
          // 健管师改过名的任务不再自动生成标题
          ...(input.title !== undefined
            ? { title: input.title, title_source: 'manual' as const }
            : {}),
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
      const found = await selectTask(trx).where('id', '=', id).executeTakeFirst();
      if (!found) return undefined;
      const [task] = await backfillTitles(trx, [found]);
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
          'report_refs',
          'expert_refs',
          'excluded_experts',
          'twin_refs',
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
              'label_date',
              'label_time',
              'consultation_id',
              'expert_ids',
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
      const uploads = await selectUploadSummary(trx)
        .where('u.task_id', '=', id)
        .orderBy('u.created_at')
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
          reportRefs: m.report_refs,
          expertRefs: m.expert_refs,
          excludedExperts: m.excluded_experts,
          twinRefs: Array.isArray(m.twin_refs) ? (m.twin_refs as TaskMessage['twinRefs']) : [],
          status: m.status,
          createdAt: m.created_at.toISOString(),
        })),
        steps: steps.map((s): TaskStep => ({
          id: s.id,
          messageId: s.message_id,
          seq: s.seq,
          kind: s.kind,
          labelKey: s.label_key,
          labelDate: s.label_date,
          labelTime: s.label_time?.toISOString() ?? null,
          consultationId: s.consultation_id,
          expertIds: s.expert_ids,
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
        uploads: uploads.map(toUploadSummary),
      };
    });
  }
}

const TASK_COLUMNS = [
  'id',
  'title',
  'title_source',
  'client_id',
  'archived_at',
  'detached_reason',
  'expert_id',
  'created_at',
  'updated_at',
] as const;

function selectTask(trx: TenantTransaction) {
  return trx.selectFrom('tasks').select(TASK_COLUMNS);
}

/** 客户称呼（行级安全决定能不能读到）；读不到时标题里不写称呼 */
async function clientNames(
  trx: TenantTransaction,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!unique.length) return new Map();
  const rows = await trx
    .selectFrom('clients')
    .select(['id', 'display_name'])
    .where('id', 'in', unique)
    .execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/**
 * 发消息时按这一轮生成任务标题（产品负责人反馈：列表里每一行都是“新任务”）：
 * - 还是默认标题时生成；
 * - 上次是按问题摘要生成的（auto_text），这一轮调用了技能时换成技能标题；
 * - 健管师给过或改过标题（manual）、已经是技能标题时不动。
 * 不改 updated_at（prepareTurn 已经更新）。标题含客户称呼，不写日志。
 */
export async function applyAutoTitle(
  trx: TenantTransaction,
  task: { id: string; title_source: TaskTitleSource },
  clientId: string | null,
  turn: TitleTurn,
): Promise<void> {
  if (task.title_source === 'manual' || task.title_source === 'auto_skill') return;
  if (task.title_source === 'auto_text' && !turn.skillId) return;
  const name = clientId ? ((await clientNames(trx, [clientId])).get(clientId) ?? null) : null;
  const { title, source } = buildTaskTitle(turn, name);
  await trx
    .updateTable('tasks')
    .set({ title, title_source: source })
    .where('id', '=', task.id)
    .where('title_source', '=', task.title_source)
    .execute();
}

type TaskRow = Parameters<typeof toTask>[0];

/**
 * 补标题（读时补，不在迁移里复制标题规则）：上线前建的任务还是“新任务”，读列表或详情时按第一条
 * 健管师消息生成标题。只读任务（客户已转出或删除）不能写，只在返回结果里换上生成的标题。
 * 不改 updated_at，列表顺序不变。
 */
async function backfillTitles(trx: TenantTransaction, rows: TaskRow[]): Promise<TaskRow[]> {
  const pending = rows.filter((r) => r.title_source === 'default');
  if (!pending.length) return rows;
  const firsts = await trx
    .selectFrom('task_messages')
    .distinctOn('task_id')
    .select(['task_id', 'mode', 'skill_id', 'content', 'expert_refs', 'twin_refs'])
    .where(
      'task_id',
      'in',
      pending.map((r) => r.id),
    )
    .where('role', '=', 'manager')
    .orderBy('task_id')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (!firsts.length) return rows;
  const byTask = new Map(firsts.map((m) => [m.task_id, m]));
  const names = await clientNames(
    trx,
    pending.map((r) => r.client_id),
  );
  const titled = new Map<string, TaskRow>();
  // 按 id 顺序逐个更新，和发消息时锁任务的顺序无关，避免死锁
  for (const row of [...pending].sort((a, b) => a.id.localeCompare(b.id))) {
    const m = byTask.get(row.id);
    if (!m) continue;
    const twinRefs = Array.isArray(m.twin_refs) ? (m.twin_refs as TitleTurn['twinRefs']) : [];
    const { title, source } = buildTaskTitle(
      {
        mode: m.mode,
        skillId: m.skill_id,
        content: m.content,
        // 消息上没有记“请专家看看”，按默认问题识别
        twinConsult: twinRefs.length > 0 && m.content.startsWith(TWIN_CONSULT_DEFAULT_REQUEST),
        twinRefs,
        expertIds: row.expert_id ? [row.expert_id] : m.expert_refs,
      },
      row.client_id ? (names.get(row.client_id) ?? null) : null,
    );
    if (!row.detached_reason) {
      await trx
        .updateTable('tasks')
        .set({ title, title_source: source })
        .where('id', '=', row.id)
        .where('title_source', '=', 'default')
        .where('detached_reason', 'is', null)
        .execute();
    }
    titled.set(row.id, { ...row, title, title_source: source });
  }
  return rows.map((r) => titled.get(r.id) ?? r);
}

/**
 * 客户是否对当前账号可见（客户表的行级安全决定）。
 * lock 为 true 时加共享锁，挡住同时进行的客户转出，直到本事务提交。
 */
export async function clientVisible(
  trx: TenantTransaction,
  clientId: string,
  lock = false,
): Promise<boolean> {
  const query = trx.selectFrom('clients').select('id').where('id', '=', clientId);
  const row = await (lock ? query.forShare() : query).executeTakeFirst();
  return Boolean(row);
}

function toTask(row: {
  id: string;
  title: string;
  title_source: TaskTitleSource;
  client_id: string | null;
  archived_at: Date | null;
  detached_reason: Task['detachedReason'];
  expert_id: string | null;
  created_at: Date;
  updated_at: Date;
}): Task {
  return {
    id: row.id,
    title: row.title,
    clientId: row.client_id,
    archived: row.archived_at !== null,
    detachedReason: row.detached_reason,
    expertId: row.expert_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * 产物摘要。依据的报告日期和原件文件名用于界面上的标题（验收反馈：“体检报告（文件名）解读 · 第 1 版”），
 * 用子查询取，同样受行级安全约束：看不到的报告和原件取出来是空。
 */
export function selectArtifactSummary(trx: TenantTransaction) {
  return trx
    .selectFrom('artifacts')
    .select(['id', 'task_id', 'skill_id', 'version', 'status', 'critical_flags', 'created_at'])
    .select((eb) => [
      eb
        .selectFrom('health_reports')
        .select((r) =>
          r
            .fn<string>('to_char', [r.ref('health_reports.report_date'), r.val('YYYY-MM-DD')])
            .as('d'),
        )
        .whereRef('health_reports.id', '=', 'artifacts.source_report_id')
        .as('source_report_date'),
      eb
        .selectFrom('report_files')
        .innerJoin('report_uploads', 'report_uploads.id', 'report_files.upload_id')
        .select('report_files.original_name')
        .whereRef('report_uploads.report_id', '=', 'artifacts.source_report_id')
        .orderBy('report_uploads.created_at', 'desc')
        .orderBy('report_files.seq')
        .limit(1)
        .as('source_file_name'),
    ]);
}

export function toArtifactSummary(row: {
  id: string;
  task_id: string;
  skill_id: string;
  version: number;
  status: ArtifactSummary['status'];
  critical_flags: unknown[];
  created_at: Date;
  source_report_date: string | null;
  source_file_name: string | null;
}): ArtifactSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    skillId: row.skill_id,
    version: row.version,
    status: row.status,
    hasCriticalFlags: row.critical_flags.length > 0,
    createdAt: row.created_at.toISOString(),
    sourceReportDate: row.source_report_date,
    sourceFileName: row.source_file_name,
  };
}
