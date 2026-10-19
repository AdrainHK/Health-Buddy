import { Inject, Injectable } from '@nestjs/common';
import type { ExpertCallResult } from '@health-buddy/ai-engine';
import {
  expertOpinionSchema,
  routingDecisionSchema,
  synthesisSchema,
  type ConsultationOrigin,
  type ConsultationStatus,
  type ConsultationTrigger,
  type ExpertCall,
  type ExpertConsultation,
  type ExpertFeedbackRequest,
  type RoutingDecision,
  type SelectedReason,
  type Synthesis,
  type SynthesisStatus,
  type TwinRef,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { expertUsageStats, type ExpertUsageStatsRow } from '../db/expert-functions.js';
import { lockExpertQuota } from '../db/locks.js';

/** 今天的专家调用次数已经用完（并发请求在事务里重新数时发现），这次一位专家都不请 */
export class ExpertQuotaExceeded extends Error {
  constructor() {
    super('expert daily quota exceeded');
    this.name = 'ExpertQuotaExceeded';
  }
}

/** 一次调用里要请的一位专家 */
export interface PlannedCall {
  expertId: string;
  version: string;
  sourcesVersion: string;
  selectedReason: SelectedReason;
}

/** 心理危机 / 疑似急症信号（合规审查第 1 条） */
export interface ConsultationSignals {
  crisis: boolean;
  emergency: boolean;
}

/** 只写为 true 的信号：插入时已有的信号不会被清除（数据库触发器也拦着） */
function raisedSignals(signals: ConsultationSignals) {
  return {
    ...(signals.crisis ? { crisis_signal: true } : {}),
    ...(signals.emergency ? { emergency_signal: true } : {}),
  };
}

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

  /**
   * 专家调用统计（规格 6.2、6.4）：只走数据库的 SECURITY DEFINER 函数，不读明细表。
   * 运营商只能拿到本协会的行（operatorId 被数据库忽略），平台管理员看全部或按协会筛选。
   */
  usageStats(
    ctx: TenantContext,
    range: { from: string; to: string; operatorId: string | null },
  ): Promise<ExpertUsageStatsRow[]> {
    return withTenant(this.db, ctx, (trx) => expertUsageStats(trx, range));
  }

  /** 协会名称（平台管理员的统计筛选和表格用）。行级安全：平台看全部，运营商只看本协会 */
  operators(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
    return withTenant(this.db, ctx, (trx) =>
      trx.selectFrom('operators').select(['id', 'name']).orderBy('name').orderBy('id').execute(),
    );
  }

  /** 平台的上下架开关（Q11）：是否启用和最后操作时间，不读操作人 */
  availability(ctx: TenantContext): Promise<Map<string, { enabled: boolean; updatedAt: Date }>> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('expert_availability')
        .select(['expert_id', 'enabled', 'updated_at'])
        .execute();
      return new Map(
        rows.map((r) => [r.expert_id, { enabled: r.enabled, updatedAt: new Date(r.updated_at) }]),
      );
    });
  }

  /** 暂停、恢复记录，新的在前。行级安全只放行平台管理员 */
  availabilityEvents(ctx: TenantContext, expertId: string, limit = 50) {
    return withTenant(this.db, ctx, (trx) =>
      trx
        .selectFrom('expert_availability_events')
        .select(['id', 'expert_id', 'action', 'actor_id', 'created_at'])
        .where('expert_id', '=', expertId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute(),
    );
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
    return withTenant(this.db, ctx, (trx) => countToday(trx));
  }

  /**
   * 新建一次专家调用，并在同一个事务里为选中的每位专家占好调用记录（状态“进行中”）。
   * 先拿这位健管师的配额锁、重新数今天的调用次数，超过每日上限就整体回滚并抛 ExpertQuotaExceeded，
   * 两个并发请求不会一起越过上限（租户隔离审查）。返回调用 id 和每位专家的调用记录 id。
   */
  createConsultation(
    ctx: TenantContext,
    input: {
      taskId: string;
      messageId: string;
      clientId: string | null;
      reportId: string | null;
      trigger: ConsultationTrigger;
      routing: RoutingDecision;
      /** 关键词识别出的信号：插入时就写好，调用中途出错也不会丢 */
      signals: ConsultationSignals;
      /** 重新请专家、补请专家时，派生自哪次调用（同一任务） */
      origin?: ConsultationOrigin | null;
      /** 这次调用回答的健管师消息，和请求里与专家有关的部分（10 分钟内复用意见时比较） */
      requestMessageId?: string | null;
      requestKey?: string | null;
      /**
       * “请专家看看”（M4 规格 2.6 之二）：针对的孪生项和发起的跟进项。跟进项必须是这位客户、
       * 这位健管师的（触发器和复合外键再确认）；有专家被请时在同一事务里记一条“已请专家”事件
       */
      twinRefs?: readonly TwinRef[];
      followUpItemId?: string | null;
    },
    calls: readonly PlannedCall[],
    dailyLimit: number,
  ): Promise<{ consultationId: string; callIds: Map<string, string> }> {
    return withTenant(this.db, ctx, async (trx) => {
      if (calls.length) {
        await lockExpertQuota(trx, ctx.userId);
        if ((await countToday(trx)) + calls.length > dailyLimit) throw new ExpertQuotaExceeded();
      }
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
          crisis_signal: input.signals.crisis,
          emergency_signal: input.signals.emergency,
          origin_id: input.origin?.consultationId ?? null,
          origin_kind: input.origin?.kind ?? null,
          request_message_id: input.requestMessageId ?? null,
          request_key: input.requestKey ?? null,
          follow_up_item_id: input.followUpItemId ?? null,
          twin_refs: input.twinRefs?.length ? JSON.stringify(input.twinRefs) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // 跟进项显示“已请专家（时间）”，状态不变（2.6 之二第 8 条）；没有专家被请时不记
      if (input.followUpItemId && input.clientId && calls.length) {
        await trx
          .insertInto('follow_up_events')
          .values({
            client_id: input.clientId,
            item_id: input.followUpItemId,
            actor_id: ctx.userId,
            action: 'consulted',
          })
          .execute();
      }
      const callIds = new Map<string, string>();
      for (const call of calls) {
        const inserted = await trx
          .insertInto('expert_calls')
          .values({
            ...tenantScope(ctx),
            consultation_id: row.id,
            expert_id: call.expertId,
            expert_version: call.version,
            sources_version: call.sourcesVersion,
            selected_reason: call.selectedReason,
            status: 'running',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        callIds.set(call.expertId, inserted.id);
      }
      return { consultationId: row.id, callIds };
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
    signals: ConsultationSignals,
  ): Promise<void> {
    const write = (s: typeof status, withSynthesis: boolean) =>
      withTenant(this.db, ctx, (trx) =>
        trx
          .updateTable('expert_consultations')
          .set({
            status: s,
            synthesis: withSynthesis && synthesis ? JSON.stringify(synthesis) : null,
            synthesis_status: withSynthesis ? synthesisStatus : null,
            ...raisedSignals(signals),
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
  async stopRunning(
    ctx: TenantContext,
    consultationId: string,
    signals: ConsultationSignals,
  ): Promise<void> {
    await withTenant(this.db, ctx, async (trx) => {
      await trx
        .updateTable('expert_calls')
        .set({ status: 'stopped' })
        .where('consultation_id', '=', consultationId)
        .where('status', '=', 'running')
        .execute();
      await trx
        .updateTable('expert_consultations')
        .set({ status: 'stopped', ...raisedSignals(signals) })
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
        .where('expert_consultations.task_id', '=', taskId)
        .orderBy('expert_consultations.created_at', 'desc')
        .orderBy('expert_consultations.id')
        .execute();
      return withCalls(trx, rows);
    });
  }

  /**
   * 10 分钟内可以复用的上一次调用（规格 3.7）：同一任务、同一位客户、同一份报告、同样的专家请求、
   * 同样的问题原文，全部专家都已回复，依据的报告之后没有更正过。找不到时返回 undefined。
   * 问题原文只在数据库里比较，不读出来。
   */
  findReusable(
    ctx: TenantContext,
    q: {
      taskId: string;
      clientId: string | null;
      reportId: string | null;
      requestKey: string;
      question: string;
      since: Date;
    },
  ): Promise<ExpertConsultation | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await selectConsultation(trx)
        .innerJoin('task_messages as m', 'm.id', 'expert_consultations.request_message_id')
        .where('expert_consultations.task_id', '=', q.taskId)
        .where('expert_consultations.status', '=', 'done')
        .where('expert_consultations.request_key', '=', q.requestKey)
        .where('expert_consultations.created_at', '>=', q.since)
        .where((eb) =>
          q.clientId === null
            ? eb('expert_consultations.client_id', 'is', null)
            : eb('expert_consultations.client_id', '=', q.clientId),
        )
        .where((eb) =>
          q.reportId === null
            ? eb('expert_consultations.report_id', 'is', null)
            : eb('expert_consultations.report_id', '=', q.reportId),
        )
        .where('m.content', '=', q.question)
        .orderBy('expert_consultations.created_at', 'desc')
        .limit(1)
        .execute();
      const [found] = await withCalls(trx, rows);
      return found && !found.reportCorrectedSince ? found : undefined;
    });
  }

  get(ctx: TenantContext, id: string): Promise<ExpertConsultation | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await selectConsultation(trx)
        .where('expert_consultations.id', '=', id)
        .execute();
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

/** 今天（UTC）本人的专家调用次数；行级安全保证只数自己的 */
async function countToday(trx: TenantTransaction): Promise<number> {
  const row = await trx
    .selectFrom('expert_calls')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('started_at', '>=', startOfDay())
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

function selectConsultation(trx: TenantTransaction) {
  return trx
    .selectFrom('expert_consultations')
    .select([
      'expert_consultations.id',
      'expert_consultations.task_id',
      'expert_consultations.message_id',
      'expert_consultations.trigger',
      'expert_consultations.status',
      'expert_consultations.routing',
      'expert_consultations.synthesis',
      'expert_consultations.synthesis_status',
      'expert_consultations.crisis_signal',
      'expert_consultations.emergency_signal',
      'expert_consultations.report_id',
      'expert_consultations.origin_id',
      'expert_consultations.origin_kind',
      'expert_consultations.follow_up_item_id',
      'expert_consultations.twin_refs',
      'expert_consultations.created_at',
      'expert_consultations.finished_at',
    ]);
}

/**
 * 依据的报告在调用之后有没有指标被更正（更正会插入新的指标行，M2 规格 2.4），和产物的 correctedSince 同一口径。
 * 行级安全下看不到的报告（客户已转出）查不到指标行，按没有更正处理。
 */
async function correctedReports(
  trx: TenantTransaction,
  rows: readonly ConsultationRow[],
): Promise<Map<string, Date>> {
  const ids = [...new Set(rows.flatMap((r) => (r.report_id ? [r.report_id] : [])))];
  if (!ids.length) return new Map();
  const latest = await trx
    .selectFrom('report_indicators')
    .select((eb) => ['report_id', eb.fn.max('created_at').as('latest')])
    .where('report_id', 'in', ids)
    .groupBy('report_id')
    .execute();
  return new Map(latest.map((r) => [r.report_id, new Date(r.latest)]));
}

type ConsultationRow = Awaited<
  ReturnType<ReturnType<typeof selectConsultation>['execute']>
>[number];

async function withCalls(
  trx: TenantTransaction,
  rows: ConsultationRow[],
): Promise<ExpertConsultation[]> {
  if (!rows.length) return [];
  const indicatorsAt = await correctedReports(trx, rows);
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
    origin:
      r.origin_id && r.origin_kind ? { kind: r.origin_kind, consultationId: r.origin_id } : null,
    followUpItemId: r.follow_up_item_id,
    twinRefs: Array.isArray(r.twin_refs) ? (r.twin_refs as TwinRef[]) : [],
    reportCorrectedSince: Boolean(
      r.report_id && (indicatorsAt.get(r.report_id)?.getTime() ?? 0) > r.created_at.getTime(),
    ),
    routing: routingDecisionSchema.parse(r.routing),
    synthesis: r.synthesis === null ? null : synthesisSchema.parse(r.synthesis),
    synthesisStatus: r.synthesis_status,
    crisisSignal: r.crisis_signal,
    emergencySignal: r.emergency_signal,
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
