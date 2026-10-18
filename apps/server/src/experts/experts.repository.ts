import { Inject, Injectable } from '@nestjs/common';
import type { ExpertCallResult } from '@health-buddy/ai-engine';
import {
  expertOpinionSchema,
  routingDecisionSchema,
  synthesisSchema,
  type ConsultationStatus,
  type ConsultationTrigger,
  type ExpertCall,
  type ExpertConsultation,
  type ExpertFeedbackRequest,
  type RoutingDecision,
  type SelectedReason,
  type Synthesis,
  type SynthesisStatus,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

function tenantScope(ctx: TenantContext) {
  return { operator_id: ctx.operatorId ?? '', org_id: ctx.orgId, manager_id: ctx.userId };
}

/** 当天 0 点（UTC）。每日专家调用上限按这个时间统计 */
function startOfDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * 专家调用的数据库操作（M3 规格 6.1、6.2）。所有读写都经过 withTenant：
 * 明细表只对健管师本人开放，查不到就是不存在或不属于当前健管师。
 * 每位专家回复后单独开一个短事务写库，引擎在后台运行时不占用事务。
 */
@Injectable()
export class ExpertsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 平台暂停的专家（Q11）。任何登录账号都能读 */
  pausedExperts(ctx: TenantContext): Promise<Set<string>> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('expert_availability')
        .select('expert_id')
        .where('enabled', '=', false)
        .execute();
      return new Set(rows.map((r) => r.expert_id));
    });
  }

  /** 平台管理员暂停或恢复专家；记录由触发器写入 */
  setAvailability(ctx: TenantContext, expertId: string, enabled: boolean): Promise<void> {
    return withTenant(this.db, ctx, async (trx) => {
      await trx
        .insertInto('expert_availability')
        .values({ expert_id: expertId, enabled, updated_by: ctx.userId })
        .onConflict((oc) => oc.column('expert_id').doUpdateSet({ enabled, updated_by: ctx.userId }))
        .execute();
    });
  }

  /** 本人使用某位专家的次数（Q15） */
  usageCount(ctx: TenantContext, expertId: string): Promise<number> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('expert_calls')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('expert_id', '=', expertId)
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    });
  }

  /** 本人今天的专家调用次数（Q12，路由和汇总不计） */
  callsToday(ctx: TenantContext): Promise<number> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('expert_calls')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('started_at', '>=', startOfDay())
        .executeTakeFirst();
      return Number(row?.n ?? 0);
    });
  }

  createConsultation(
    ctx: TenantContext,
    input: {
      taskId: string;
      messageId: string;
      clientId: string | null;
      reportId: string | null;
      trigger: ConsultationTrigger;
      routing: RoutingDecision;
    },
  ): Promise<string> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('expert_consultations')
        .values({
          ...tenantScope(ctx),
          task_id: input.taskId,
          message_id: input.messageId,
          client_id: input.clientId,
          report_id: input.reportId,
          trigger: input.trigger,
          routing: JSON.stringify(input.routing),
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  startCall(
    ctx: TenantContext,
    consultationId: string,
    expert: { id: string; version: string; sourcesVersion: string },
    selectedReason: SelectedReason,
  ): Promise<string> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('expert_calls')
        .values({
          ...tenantScope(ctx),
          consultation_id: consultationId,
          expert_id: expert.id,
          expert_version: expert.version,
          sources_version: expert.sourcesVersion,
          selected_reason: selectedReason,
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /**
   * 写入一位专家的结果。任务在调用期间变成只读（客户转出）时，数据库拒绝写意见，
   * 这时只把状态记为已停止，不保留意见。
   */
  async finishCall(ctx: TenantContext, callId: string, r: ExpertCallResult): Promise<void> {
    const write = (status: ExpertCallResult['status'], opinion: boolean) =>
      withTenant(this.db, ctx, (trx) =>
        trx
          .updateTable('expert_calls')
          .set({
            status,
            failure_category: status === r.status ? r.failureCategory : null,
            opinion: opinion && r.opinion ? JSON.stringify(r.opinion) : null,
            removed_findings: r.removedFindings,
            provider: r.provider,
            model: r.model,
            input_tokens: r.usage.inputTokens,
            output_tokens: r.usage.outputTokens,
          })
          .where('id', '=', callId)
          .where('status', '=', 'running')
          .execute(),
      );
    try {
      await write(r.status, true);
    } catch {
      await write('stopped', false).catch(() => undefined);
    }
  }

  /** 结束一次调用：状态改为终态，写汇总。只读任务不写汇总 */
  async finishConsultation(
    ctx: TenantContext,
    id: string,
    status: Exclude<ConsultationStatus, 'running'>,
    synthesis: Synthesis | null,
    synthesisStatus: SynthesisStatus | null,
  ): Promise<void> {
    const write = (s: typeof status, withSynthesis: boolean) =>
      withTenant(this.db, ctx, (trx) =>
        trx
          .updateTable('expert_consultations')
          .set({
            status: s,
            synthesis: withSynthesis && synthesis ? JSON.stringify(synthesis) : null,
            synthesis_status: withSynthesis ? synthesisStatus : null,
          })
          .where('id', '=', id)
          .where('status', '=', 'running')
          .execute(),
      );
    try {
      await write(status, true);
    } catch {
      await write('stopped', false).catch(() => undefined);
    }
  }

  /** 收尾：把还在进行的专家调用标为已停止（出错、停止时） */
  async stopRunning(ctx: TenantContext, consultationId: string): Promise<void> {
    await withTenant(this.db, ctx, async (trx) => {
      await trx
        .updateTable('expert_calls')
        .set({ status: 'stopped' })
        .where('consultation_id', '=', consultationId)
        .where('status', '=', 'running')
        .execute();
      await trx
        .updateTable('expert_consultations')
        .set({ status: 'stopped' })
        .where('id', '=', consultationId)
        .where('status', '=', 'running')
        .execute();
    }).catch(() => undefined);
  }

  /** 任务里的专家调用（专家标签）。任务不属于当前健管师时返回 undefined */
  listForTask(ctx: TenantContext, taskId: string): Promise<ExpertConsultation[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const task = await trx
        .selectFrom('tasks')
        .select('id')
        .where('id', '=', taskId)
        .executeTakeFirst();
      if (!task) return undefined;
      const rows = await selectConsultation(trx)
        .where('task_id', '=', taskId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .execute();
      return withCalls(trx, rows);
    });
  }

  get(ctx: TenantContext, id: string): Promise<ExpertConsultation | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await selectConsultation(trx).where('id', '=', id).execute();
      return (await withCalls(trx, rows))[0];
    });
  }

  /**
   * 有用/没用（Q14）：每位健管师对每条意见最多一条，可以改。
   * 意见不属于当前健管师时返回 'missing'；还没回复的意见、只读任务返回 'conflict'。
   */
  setFeedback(
    ctx: TenantContext,
    callId: string,
    body: Required<ExpertFeedbackRequest>,
  ): Promise<'ok' | 'missing' | 'conflict'> {
    return withTenant(this.db, ctx, async (trx) => {
      const call = await trx
        .selectFrom('expert_calls')
        .innerJoin('expert_consultations as c', 'c.id', 'expert_calls.consultation_id')
        .innerJoin('tasks as t', 't.id', 'c.task_id')
        .select(['expert_calls.id', 'expert_calls.status', 't.detached_reason'])
        .where('expert_calls.id', '=', callId)
        .executeTakeFirst();
      if (!call) return 'missing';
      if (call.status !== 'done' || call.detached_reason) return 'conflict';
      await trx
        .insertInto('expert_feedback')
        .values({
          ...tenantScope(ctx),
          expert_call_id: callId,
          rating: body.rating,
          reason: body.reason,
        })
        .onConflict((oc) =>
          oc
            .columns(['expert_call_id', 'manager_id'])
            .doUpdateSet({ rating: body.rating, reason: body.reason }),
        )
        .execute();
      return 'ok';
    });
  }
}

function selectConsultation(trx: TenantTransaction) {
  return trx
    .selectFrom('expert_consultations')
    .select([
      'id',
      'task_id',
      'message_id',
      'trigger',
      'status',
      'routing',
      'synthesis',
      'synthesis_status',
      'created_at',
      'finished_at',
    ]);
}

type ConsultationRow = Awaited<
  ReturnType<ReturnType<typeof selectConsultation>['execute']>
>[number];

async function withCalls(
  trx: TenantTransaction,
  rows: ConsultationRow[],
): Promise<ExpertConsultation[]> {
  if (!rows.length) return [];
  const calls = await trx
    .selectFrom('expert_calls')
    .leftJoin('expert_feedback as f', 'f.expert_call_id', 'expert_calls.id')
    .select([
      'expert_calls.id',
      'expert_calls.consultation_id',
      'expert_calls.expert_id',
      'expert_calls.expert_version',
      'expert_calls.selected_reason',
      'expert_calls.status',
      'expert_calls.failure_category',
      'expert_calls.opinion',
      'expert_calls.removed_findings',
      'expert_calls.started_at',
      'expert_calls.finished_at',
      'f.rating',
      'f.reason',
    ])
    .where(
      'expert_calls.consultation_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('expert_calls.started_at')
    .orderBy('expert_calls.expert_id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    messageId: r.message_id,
    trigger: r.trigger,
    status: r.status,
    routing: routingDecisionSchema.parse(r.routing),
    synthesis: r.synthesis === null ? null : synthesisSchema.parse(r.synthesis),
    synthesisStatus: r.synthesis_status,
    calls: calls
      .filter((c) => c.consultation_id === r.id)
      .map((c): ExpertCall => ({
        id: c.id,
        expertId: c.expert_id,
        expertVersion: c.expert_version,
        selectedReason: c.selected_reason,
        status: c.status,
        failureCategory: c.failure_category,
        opinion: c.opinion === null ? null : expertOpinionSchema.parse(c.opinion),
        removedFindings: c.removed_findings,
        feedback: c.rating ? { rating: c.rating, reason: c.reason ?? null } : null,
        startedAt: c.started_at.toISOString(),
        finishedAt: c.finished_at?.toISOString() ?? null,
      })),
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  }));
}
