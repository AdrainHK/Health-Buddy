import { Inject, Injectable } from '@nestjs/common';
import {
  detectCriticalFlags,
  type ArtifactSummary,
  type CriticalFlag,
  type IndicatorCode,
  type Observation,
  type PlanStep,
  type TaskMode,
  type TaskPlan,
  type TaskStep,
} from '@health-buddy/shared';
import type { ClientSnapshot } from '@health-buddy/skills';
import type { ChatMessage } from '@health-buddy/ai-engine';
import { badRequest, conflict, notFound } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import {
  clientVisible,
  selectArtifactSummary,
  toArtifactSummary,
} from '../tasks/tasks.repository.js';

const readOnly = () => conflict({ reasons: ['read_only'] });

/** 发给模型的历史对话最多带几条 */
const HISTORY_LIMIT = 12;
/** 识别心理危机信号时回看健管师消息的条数 */
const CRISIS_SCAN_LIMIT = 50;
const MONITORING_DAYS = 30;

export interface PreparedTurn {
  taskId: string;
  clientId: string | null;
  managerMessageId: string;
  assistantMessageId: string;
}

export interface ClientContext {
  snapshot: ClientSnapshot;
  /** 去标识化用：提示词里要替换掉的姓名等字样，只在内存里用，不写日志 */
  identifiers: string[];
}

export interface RegenerationContext {
  taskId: string;
  clientId: string | null;
  skillId: string;
  managerRequest: string;
  assistantMessageId: string;
  parent: { id: string; lineageId: string; version: number } | undefined;
}

export interface NewArtifact {
  skillId: string;
  kind: string;
  professional: string;
  clientFacing: string;
  criticalFlags: CriticalFlag[];
  parent: { id: string; lineageId: string; version: number } | undefined;
}

/**
 * 对话和生成用到的数据库操作（规格第五节“流式接口持有租户上下文的方式”）：
 * 每次写库都是一个短事务，长时间的生成不占用事务和连接。
 */
@Injectable()
export class WorkbenchRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 发消息前的准备：校验任务、客户引用和技能，写入健管师的消息和一条“生成中”的回答。
   * claim 在归属校验通过后、写入之前调用，用来占住这个任务的生成（同一任务不并行）。
   */
  prepareTurn(
    ctx: TenantContext,
    input: {
      taskId: string;
      mode: TaskMode;
      content: string;
      skillId: string | undefined;
      clientRefs: string[];
      requiresClient: boolean;
    },
    claim: (taskId: string) => boolean,
  ): Promise<PreparedTurn> {
    return withTenant(this.db, ctx, async (trx) => {
      const task = await lockTask(trx, input.taskId);
      let clientId = task.client_id;
      const ref = input.clientRefs[0];
      if (ref) {
        // 每个任务只关联一位客户（Q6）；看不到的客户和别的客户都按“不存在”处理
        if (clientId && ref !== clientId) throw notFound();
        if (!clientId) {
          if (!(await clientVisible(trx, ref))) throw notFound();
          await trx
            .updateTable('tasks')
            .set({ client_id: ref })
            .where('id', '=', task.id)
            .execute();
          clientId = ref;
        }
      }
      if (input.requiresClient && !clientId) throw badRequest();
      if (!claim(task.id)) throw conflict({ reasons: ['busy'] });

      await closeStaleTurns(trx, task.id);
      // 发了新消息，之前没确认的计划视为“修改计划”
      await trx
        .updateTable('task_plans')
        .set({ status: 'revised' })
        .where('status', '=', 'proposed')
        .where('message_id', 'in', (eb) =>
          eb.selectFrom('task_messages').select('id').where('task_id', '=', task.id),
        )
        .execute();

      const now = Date.now();
      const scope = tenantScope(ctx);
      const manager = await trx
        .insertInto('task_messages')
        .values({
          ...scope,
          task_id: task.id,
          role: 'manager',
          mode: input.mode,
          content: input.content,
          skill_id: input.skillId ?? null,
          client_refs: clientId && ref ? [clientId] : [],
          status: 'complete',
          created_at: new Date(now),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const assistant = await insertAssistant(
        trx,
        ctx,
        task.id,
        input.mode,
        input.skillId,
        now + 1,
      );
      await trx
        .updateTable('tasks')
        .set({ updated_at: new Date() })
        .where('id', '=', task.id)
        .execute();
      return {
        taskId: task.id,
        clientId,
        managerMessageId: manager.id,
        assistantMessageId: assistant,
      };
    });
  }

  /** 确认计划（规格 3.3）：计划必须是这个任务里待确认的那份 */
  confirmPlan(
    ctx: TenantContext,
    taskId: string,
    planId: string,
    claim: (taskId: string) => boolean,
  ): Promise<RegenerationContext> {
    return withTenant(this.db, ctx, async (trx) => {
      const task = await lockTask(trx, taskId);
      const plan = await trx
        .selectFrom('task_plans')
        .innerJoin('task_messages', 'task_messages.id', 'task_plans.message_id')
        .select([
          'task_plans.id',
          'task_plans.steps',
          'task_plans.status',
          'task_messages.created_at',
        ])
        .where('task_plans.id', '=', planId)
        .where('task_messages.task_id', '=', task.id)
        .forUpdate('task_plans')
        .executeTakeFirst();
      if (!plan) throw notFound();
      if (plan.status !== 'proposed') throw conflict();
      const skillStep = (plan.steps as PlanStep[]).find((s) => s.kind === 'run_skill');
      if (!skillStep || skillStep.kind !== 'run_skill') throw conflict();
      const request = await trx
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', task.id)
        .where('role', '=', 'manager')
        .where('created_at', '<', plan.created_at)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!request) throw conflict();
      if (!claim(task.id)) throw conflict({ reasons: ['busy'] });

      await closeStaleTurns(trx, task.id);
      await trx
        .updateTable('task_plans')
        .set({ status: 'confirmed' })
        .where('id', '=', plan.id)
        .execute();
      const assistant = await insertAssistant(
        trx,
        ctx,
        task.id,
        'craft',
        skillStep.skillId,
        Date.now(),
      );
      return {
        taskId: task.id,
        clientId: task.client_id,
        skillId: skillStep.skillId,
        managerRequest: request.content,
        assistantMessageId: assistant,
        parent: undefined,
      };
    });
  }

  /**
   * 退回重写（规格 3.6）：只能退回最新一版草稿。产物改为“已退回”并记下原因，
   * 再写一条“生成中”的回答，用来挂执行步骤。
   */
  returnArtifact(
    ctx: TenantContext,
    artifactId: string,
    reason: string,
    claim: (taskId: string) => boolean,
  ): Promise<RegenerationContext> {
    return withTenant(this.db, ctx, async (trx) => {
      const ref = await trx
        .selectFrom('artifacts')
        .select('task_id')
        .where('id', '=', artifactId)
        .executeTakeFirst();
      if (!ref) throw notFound();
      const task = await lockTask(trx, ref.task_id);
      const artifact = await trx
        .selectFrom('artifacts')
        .select(['id', 'skill_id', 'lineage_id', 'version', 'status', 'created_at'])
        .where('id', '=', artifactId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const newer = await trx
        .selectFrom('artifacts')
        .select('id')
        .where('lineage_id', '=', artifact.lineage_id)
        .where('version', '>', artifact.version)
        .executeTakeFirst();
      if (artifact.status !== 'draft' || newer) throw conflict({ reasons: ['not_latest_draft'] });
      const request = await trx
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', task.id)
        .where('role', '=', 'manager')
        .where('skill_id', '=', artifact.skill_id)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!claim(task.id)) throw conflict({ reasons: ['busy'] });

      await closeStaleTurns(trx, task.id);
      await trx
        .updateTable('artifacts')
        .set({ status: 'returned' })
        .where('id', '=', artifact.id)
        .execute();
      await trx
        .insertInto('artifact_events')
        .values({
          ...tenantScope(ctx),
          artifact_id: artifact.id,
          actor_id: ctx.userId,
          action: 'returned',
          reason,
          format: null,
        })
        .execute();
      const assistant = await insertAssistant(
        trx,
        ctx,
        task.id,
        'craft',
        artifact.skill_id,
        Date.now(),
      );
      return {
        taskId: task.id,
        clientId: task.client_id,
        skillId: artifact.skill_id,
        managerRequest: request?.content ?? '',
        assistantMessageId: assistant,
        parent: { id: artifact.id, lineageId: artifact.lineage_id, version: artifact.version },
      };
    });
  }

  /** 任务是否属于当前健管师（停止前核对归属） */
  taskVisible(ctx: TenantContext, taskId: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('tasks')
        .select('id')
        .where('id', '=', taskId)
        .executeTakeFirst();
      return Boolean(row);
    });
  }

  /**
   * 读取客户档案并识别危急指标（规格第四节、第五节之二）。
   * 按 Q9 去标识化：只给年龄段、性别和健康数据。客户已经看不到时返回 undefined。
   */
  clientContext(ctx: TenantContext, clientId: string): Promise<ClientContext | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const client = await trx
        .selectFrom('clients')
        .select(['id', 'display_name', 'gender', 'birth_year'])
        .where('id', '=', clientId)
        .executeTakeFirst();
      if (!client) return undefined;

      const since = new Date(Date.now() - MONITORING_DAYS * 24 * 60 * 60 * 1000);
      const readings = await trx
        .selectFrom('monitoring_readings')
        .select(['metric', 'value', 'unit', 'measured_at'])
        .where('client_id', '=', clientId)
        .where('measured_at', '>=', since)
        .orderBy('measured_at')
        .execute();
      const report = await trx
        .selectFrom('health_reports')
        .select(['id', 'report_date'])
        .where('client_id', '=', clientId)
        .orderBy('report_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      const indicators = report
        ? await trx
            .selectFrom('report_indicators')
            .select(['code', 'value', 'unit'])
            .where('report_id', '=', report.id)
            .orderBy('code')
            .execute()
        : [];
      const rules = await trx
        .selectFrom('critical_thresholds')
        .select(['metric', 'comparator', 'value', 'level', 'enabled'])
        .execute();

      const monitoring = new Map<string, ClientSnapshot['monitoring'][number]>();
      const observations: Observation[] = [];
      for (const r of readings) {
        const date = isoDate(r.measured_at);
        const value = Number(r.value);
        const entry = monitoring.get(r.metric) ?? { metric: r.metric, unit: r.unit, readings: [] };
        entry.readings.push({ date, value });
        monitoring.set(r.metric, entry);
        observations.push({
          metric: r.metric,
          value,
          unit: r.unit,
          observedOn: date,
          source: 'monitoring',
        });
      }
      const reportDate = report ? isoDate(report.report_date) : '';
      for (const i of indicators) {
        observations.push({
          metric: i.code,
          value: Number(i.value),
          unit: i.unit,
          observedOn: reportDate,
          source: 'report',
        });
      }
      const criticalFlags = detectCriticalFlags(
        rules.map((r) => ({
          metric: r.metric as IndicatorCode,
          comparator: r.comparator,
          value: Number(r.value),
          level: r.level,
          enabled: r.enabled,
        })),
        observations,
      );
      return {
        snapshot: {
          ageBand: ageBand(client.birth_year),
          gender: client.gender,
          monitoring: [...monitoring.values()],
          latestReport: report
            ? {
                date: reportDate,
                indicators: indicators.map((i) => ({
                  code: i.code,
                  value: Number(i.value),
                  unit: i.unit,
                })),
              }
            : null,
          criticalFlags,
        },
        identifiers: [client.display_name],
      };
    });
  }

  /** 本任务之前的对话（不含这一轮），用作问一问的上下文 */
  history(ctx: TenantContext, taskId: string, before: PreparedTurn): Promise<ChatMessage[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('task_messages')
        .select(['role', 'content'])
        .where('task_id', '=', taskId)
        .where('status', '=', 'complete')
        .where('content', '<>', '')
        .where('id', 'not in', [before.managerMessageId, before.assistantMessageId])
        .orderBy('created_at', 'desc')
        .limit(HISTORY_LIMIT)
        .execute();
      return rows
        .reverse()
        .map((r) => ({ role: r.role === 'manager' ? 'user' : 'assistant', content: r.content }));
    });
  }

  /** 本任务里健管师说过的话（最近的若干条），只用来识别心理危机信号，不进提示词 */
  managerTexts(ctx: TenantContext, taskId: string): Promise<string[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', taskId)
        .where('role', '=', 'manager')
        .orderBy('created_at', 'desc')
        .limit(CRISIS_SCAN_LIMIT)
        .execute();
      return rows.map((r) => r.content);
    });
  }

  startStep(
    ctx: TenantContext,
    messageId: string,
    seq: number,
    kind: TaskStep['kind'],
    labelKey: string,
  ): Promise<TaskStep> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('task_steps')
        .values({
          ...tenantScope(ctx),
          message_id: messageId,
          seq,
          kind,
          label_key: labelKey,
          status: 'running',
        })
        .returning([
          'id',
          'message_id',
          'seq',
          'kind',
          'label_key',
          'status',
          'started_at',
          'finished_at',
        ])
        .executeTakeFirstOrThrow();
      return toStep(row);
    });
  }

  finishStep(ctx: TenantContext, step: TaskStep, status: 'done' | 'failed'): Promise<TaskStep> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .updateTable('task_steps')
        .set({ status, finished_at: new Date() })
        .where('id', '=', step.id)
        .returning([
          'id',
          'message_id',
          'seq',
          'kind',
          'label_key',
          'status',
          'started_at',
          'finished_at',
        ])
        .executeTakeFirstOrThrow();
      return toStep(row);
    });
  }

  /** 保存回答。任务在生成期间变成只读（客户转出）时，数据库会拒绝，这里吞掉不再保存。 */
  async saveAssistant(
    ctx: TenantContext,
    messageId: string,
    content: string,
    status: 'streaming' | 'complete' | 'stopped' | 'refused' | 'error',
  ): Promise<void> {
    await withTenant(this.db, ctx, (trx) =>
      trx
        .updateTable('task_messages')
        .set({ content, status })
        .where('id', '=', messageId)
        .execute(),
    ).catch(() => undefined);
  }

  createPlan(ctx: TenantContext, messageId: string, steps: PlanStep[]): Promise<TaskPlan> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('task_plans')
        .values({
          ...tenantScope(ctx),
          message_id: messageId,
          steps: JSON.stringify(steps),
          status: 'proposed',
        })
        .returning(['id', 'message_id', 'steps', 'status'])
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        messageId: row.message_id,
        steps: row.steps as PlanStep[],
        status: row.status,
      };
    });
  }

  /**
   * 保存产物草稿。保存前在同一事务里锁住任务并重新确认：任务没有断开、客户没有变。
   * 不满足时返回 undefined，不留半成品。
   */
  saveArtifact(
    ctx: TenantContext,
    taskId: string,
    clientId: string | null,
    data: NewArtifact,
  ): Promise<ArtifactSummary | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select(['id', 'client_id', 'detached_reason'])
        .where('id', '=', taskId)
        .forShare()
        .executeTakeFirst();
      if (!task || task.detached_reason || task.client_id !== clientId) return undefined;
      if (clientId && !(await clientVisible(trx, clientId))) return undefined;

      const id = crypto.randomUUID();
      await trx
        .insertInto('artifacts')
        .values({
          ...tenantScope(ctx),
          id,
          task_id: taskId,
          client_id: clientId,
          skill_id: data.skillId,
          kind: data.kind,
          lineage_id: data.parent?.lineageId ?? id,
          version: data.parent ? data.parent.version + 1 : 1,
          parent_id: data.parent?.id ?? null,
          status: 'draft',
          content: JSON.stringify({
            professional: data.professional,
            clientFacing: data.clientFacing,
          }),
          critical_flags: JSON.stringify(data.criticalFlags),
        })
        .execute();
      await trx
        .insertInto('artifact_events')
        .values({
          ...tenantScope(ctx),
          artifact_id: id,
          actor_id: ctx.userId,
          action: 'created',
          reason: null,
          format: null,
        })
        .execute();
      await trx
        .updateTable('tasks')
        .set({ updated_at: new Date() })
        .where('id', '=', taskId)
        .execute();
      const row = await selectArtifactSummary(trx).where('id', '=', id).executeTakeFirstOrThrow();
      return toArtifactSummary(row);
    });
  }
}

function tenantScope(ctx: TenantContext) {
  return { operator_id: ctx.operatorId ?? '', org_id: ctx.orgId, manager_id: ctx.userId };
}

/** 锁住任务。不存在或不属于当前健管师 404，只读 409。 */
async function lockTask(trx: TenantTransaction, taskId: string) {
  const task = await trx
    .selectFrom('tasks')
    .select(['id', 'client_id', 'detached_reason'])
    .where('id', '=', taskId)
    .forUpdate()
    .executeTakeFirst();
  if (!task) throw notFound();
  if (task.detached_reason) throw readOnly();
  return task;
}

/** 上一次生成没有正常收尾（如服务重启）时留下的“生成中”回答，标记为出错 */
async function closeStaleTurns(trx: TenantTransaction, taskId: string) {
  await trx
    .updateTable('task_messages')
    .set({ status: 'error' })
    .where('task_id', '=', taskId)
    .where('status', '=', 'streaming')
    .execute();
}

async function insertAssistant(
  trx: TenantTransaction,
  ctx: TenantContext,
  taskId: string,
  mode: TaskMode,
  skillId: string | undefined,
  at: number,
): Promise<string> {
  const row = await trx
    .insertInto('task_messages')
    .values({
      ...tenantScope(ctx),
      task_id: taskId,
      role: 'assistant',
      mode,
      skill_id: skillId ?? null,
      status: 'streaming',
      created_at: new Date(at),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function toStep(row: {
  id: string;
  message_id: string;
  seq: number;
  kind: TaskStep['kind'];
  label_key: string;
  status: TaskStep['status'];
  started_at: Date;
  finished_at: Date | null;
}): TaskStep {
  return {
    id: row.id,
    messageId: row.message_id,
    seq: row.seq,
    kind: row.kind,
    labelKey: row.label_key,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 出生年份换成年龄段（Q9），如 1958 年出生、今年 2026 年 → “60-69” */
export function ageBand(birthYear: number | null, now = new Date()): string | null {
  if (!birthYear) return null;
  const age = now.getUTCFullYear() - birthYear;
  if (age < 0 || age > 120) return null;
  const low = Math.floor(age / 10) * 10;
  return `${low}-${low + 9}`;
}
