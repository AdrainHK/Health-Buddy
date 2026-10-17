import { Inject, Injectable } from '@nestjs/common';
import type { ExpressionBuilder } from 'kysely';
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
import {
  getSkill,
  type ClientSnapshot,
  type HealthHistoryEntry,
  type ReportDetail,
  type ReportIndicatorDetail,
} from '@health-buddy/skills';
import type { ChatMessage } from '@health-buddy/ai-engine';
import { badRequest, conflict, notFound } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { asDate } from '../db/report-functions.js';
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
  /**
   * @ 引用的已核对报告（规格 2.6）。用报告的技能没有 @ 时，这里是该客户最近一份已核对报告；
   * 其他情况为空时读档案用最近一份。
   */
  reportId: string | null;
  managerMessageId: string;
  assistantMessageId: string;
}

export interface ClientContext {
  snapshot: ClientSnapshot;
  /** 这次用的已核对报告（id 和日期）；客户没有已核对报告时为空 */
  report: { id: string; date: string } | null;
  /** 去标识化用：提示词里要替换掉的姓名等字样，只在内存里用，不写日志 */
  identifiers: string[];
  /** 通俗版开头的称呼，只在模型输出之后拼接，不发给模型 */
  displayName: string;
}

export interface RegenerationContext {
  taskId: string;
  clientId: string | null;
  /** 按顺序执行的技能。确认多步计划时有多个（Q22），退回重写时只有一个 */
  skillIds: string[];
  managerRequest: string;
  assistantMessageId: string;
  parent: { id: string; lineageId: string; version: number } | undefined;
  /** 用报告的技能依据的已核对报告 */
  reportId: string | null;
}

export interface NewArtifact {
  skillId: string;
  kind: string;
  professional: string;
  clientFacing: string;
  criticalFlags: CriticalFlag[];
  parent: { id: string; lineageId: string; version: number } | undefined;
  /** 依据的已核对报告（M2 规格 3.2） */
  sourceReportId?: string | null;
  /** AI 的建议分层（只有 /体检解读，规格 2.7） */
  riskTierSuggestion?: { tier: 'high' | 'medium' | 'low'; reason: string } | null;
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
      reportRefs: string[];
      requiresClient: boolean;
      /** 用报告的技能（规格 2.6）：没有已核对报告时拒绝，不生成 */
      requiresReport: boolean;
      /**
       * 读取报告的技能（含报告可选的 /面谈提纲）：没有 @ 报告时用最近一份已核对报告；
       * 报告可选时一份都没有也照常生成
       */
      usesReport?: boolean;
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
          // 锁住客户行：同时进行的转出要等这里提交后才执行，触发器就能看到并断开这个任务；
          // 转出已经提交的话，等锁后重新按行级安全判断，读不到，返回 404
          if (!(await clientVisible(trx, ref, true))) throw notFound();
          await trx
            .updateTable('tasks')
            .set({ client_id: ref })
            .where('id', '=', task.id)
            .execute();
          clientId = ref;
        }
      }
      if (input.requiresClient && !clientId) throw badRequest();
      // @ 引用的报告必须是任务关联客户的已核对报告，并且对当前健管师可见（规格 2.6）；
      // 待核对的识别结果不在 health_reports 里，同样按“不存在”处理
      const reportId = input.reportRefs[0] ?? null;
      if (reportId) {
        if (!clientId) throw notFound();
        const report = await trx
          .selectFrom('health_reports')
          .select('id')
          .where('id', '=', reportId)
          .where('client_id', '=', clientId)
          .executeTakeFirst();
        if (!report) throw notFound();
      }
      // 用报告的技能没有 @ 报告时用最近一份已核对报告；一份都没有时，必须要报告的技能提示
      // 先上传并核对（规格 2.6），报告可选的技能（/面谈提纲）按档案生成
      const usesReport = input.requiresReport || Boolean(input.usesReport);
      const usedReportId =
        reportId ?? (usesReport && clientId ? await latestReportId(trx, clientId) : null);
      if (input.requiresReport && !usedReportId) throw noVerifiedReport();
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
          report_refs: reportId ? [reportId] : [],
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
        reportId: usedReportId,
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
    /** 技能对报告的要求：required（/体检解读）、optional（/面谈提纲）、none */
    reportUsage: (skillId: string) => 'required' | 'optional' | 'none',
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
      // M2 起一份计划可以按顺序调用多个技能（Q22）
      const skillIds = (plan.steps as PlanStep[]).flatMap((s) =>
        s.kind === 'run_skill' ? [s.skillId] : [],
      );
      if (!skillIds.length) throw conflict();
      const request = await trx
        .selectFrom('task_messages')
        .select(['content', 'report_refs'])
        .where('task_id', '=', task.id)
        .where('role', '=', 'manager')
        .where('created_at', '<', plan.created_at)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!request) throw conflict();
      // 计划里有用报告的技能：用提出计划时 @ 的报告，没有就用最近一份已核对报告；
      // 只有报告可选的技能时，一份都没有也照常执行
      let reportId: string | null = null;
      const usage = skillIds.map(reportUsage);
      if (usage.some((u) => u !== 'none')) {
        const ref = request.report_refs[0];
        if (ref) {
          if (!task.client_id || !(await reportOfClient(trx, ref, task.client_id)))
            throw notFound();
          reportId = ref;
        } else if (task.client_id) {
          reportId = await latestReportId(trx, task.client_id);
        }
        if (!reportId && usage.includes('required')) throw noVerifiedReport();
      }
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
        skillIds.length === 1 ? skillIds[0] : undefined,
        Date.now(),
      );
      return {
        taskId: task.id,
        clientId: task.client_id,
        skillIds,
        managerRequest: request.content,
        assistantMessageId: assistant,
        parent: undefined,
        reportId,
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
    requestSkillIds: (skillId: string) => string[],
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
        .select([
          'id',
          'skill_id',
          'lineage_id',
          'version',
          'status',
          'created_at',
          'source_report_id',
        ])
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
      // 依据报告的技能只能按原来的报告重写；原报告已不可用（客户转出、报告删除）时拒绝，
      // 不悄悄换成最近一份报告
      if (getSkill(artifact.skill_id)?.requiresReport && !artifact.source_report_id) {
        throw conflict({ reasons: ['source_report_unavailable'] });
      }
      // 健管师当初的要求：直接调用这个技能的消息，或调用了包含它的多步计划的消息
      const request = await trx
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', task.id)
        .where('role', '=', 'manager')
        .where('skill_id', 'in', requestSkillIds(artifact.skill_id))
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
        skillIds: [artifact.skill_id],
        managerRequest: request?.content ?? '',
        assistantMessageId: assistant,
        parent: { id: artifact.id, lineageId: artifact.lineage_id, version: artifact.version },
        // 重写沿用原来依据的报告
        reportId: artifact.source_report_id,
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
  clientContext(
    ctx: TenantContext,
    clientId: string,
    reportId: string | null = null,
    /**
     * detail：组装报告详情、健康史和分层（用报告的技能）。
     * latestReport：没有指定报告时用最近一份（默认）；为 false 时不用报告
     * （用报告的技能，报告已在发消息、确认计划或退回时定好，为空就是没有报告）
     */
    options: { detail?: boolean; latestReport?: boolean } = {},
  ): Promise<ClientContext | undefined> {
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
      // @ 引用了报告就用那一份，否则用最近一份（都是已核对的报告）
      let reportQuery = trx
        .selectFrom('health_reports')
        .select((eb) => ['id', 'report_date', isoDateOf(eb, 'report_date').as('date')])
        .where('client_id', '=', clientId);
      reportQuery = reportId
        ? reportQuery.where('id', '=', reportId)
        : reportQuery.orderBy('report_date', 'desc').orderBy('created_at', 'desc');
      const report =
        reportId || options.latestReport !== false
          ? await reportQuery.limit(1).executeTakeFirst()
          : undefined;
      // 指定的报告看不到（不属于这位客户或已不可见）：不退回到别的报告
      if (reportId && !report) return undefined;
      // 只用目录指标的当前值；参考范围是报告上印的（Q10）
      const indicators = (
        report
          ? await trx
              .selectFrom('report_indicators')
              .select(['code', 'value', 'unit', 'ref_low', 'ref_high'])
              .where('report_id', '=', report.id)
              .where('superseded_by', 'is', null)
              .where('code', 'is not', null)
              .where('value', 'is not', null)
              .orderBy('code')
              .execute()
          : []
      ).flatMap((i) =>
        i.code === null || i.value === null
          ? []
          : [
              {
                code: i.code,
                value: Number(i.value),
                unit: i.unit,
                ...(i.ref_low === null ? {} : { refLow: Number(i.ref_low) }),
                ...(i.ref_high === null ? {} : { refHigh: Number(i.ref_high) }),
              },
            ],
      );
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
      const reportDate = report ? report.date : '';
      for (const i of indicators) {
        observations.push({
          metric: i.code,
          value: i.value,
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
      const snapshot: ClientSnapshot = {
        ageBand: ageBand(client.birth_year),
        gender: client.gender,
        monitoring: [...monitoring.values()],
        latestReport: report
          ? {
              date: reportDate,
              indicators,
            }
          : null,
        criticalFlags,
      };
      if (options.detail) {
        snapshot.reportDetail = report
          ? await reportDetail(trx, clientId, report.id, reportDate)
          : null;
        snapshot.healthHistory = await healthHistory(trx, clientId);
        snapshot.riskTier = await currentTier(trx, clientId);
      }
      return {
        snapshot,
        report: report ? { id: report.id, date: reportDate } : null,
        identifiers: [client.display_name],
        displayName: client.display_name,
      };
    });
  }

  /** 本任务之前的对话（不含这一轮），用作问一问的上下文 */
  history(
    ctx: TenantContext,
    taskId: string,
    before: Pick<PreparedTurn, 'managerMessageId' | 'assistantMessageId'>,
  ): Promise<(ChatMessage & { content: string })[]> {
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
    labelDate: string | null = null,
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
          label_date: labelDate,
          status: 'running',
        })
        .returning([
          'id',
          'message_id',
          'seq',
          'kind',
          'label_key',
          'label_date',
          'status',
          'started_at',
          'finished_at',
        ])
        .executeTakeFirstOrThrow();
      return toStep(row);
    });
  }

  /** labelDate：读完报告后才知道用的是哪一天的报告（规格 2.6），完成时一并写上 */
  finishStep(
    ctx: TenantContext,
    step: TaskStep,
    status: 'done' | 'failed',
    labelDate?: string,
  ): Promise<TaskStep> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .updateTable('task_steps')
        .set({
          status,
          finished_at: new Date(),
          ...(labelDate !== undefined ? { label_date: labelDate } : {}),
        })
        .where('id', '=', step.id)
        .returning([
          'id',
          'message_id',
          'seq',
          'kind',
          'label_key',
          'label_date',
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
          source_report_id: data.sourceReportId ?? null,
          risk_tier_suggestion: data.riskTierSuggestion
            ? JSON.stringify(data.riskTierSuggestion)
            : null,
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
  label_date: string | null;
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
    labelDate: row.label_date,
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

const noVerifiedReport = () => conflict({ reasons: ['no_verified_report'] });

/** 该客户最近一份已核对报告（按报告日期，同一天按核对先后） */
async function latestReportId(trx: TenantTransaction, clientId: string): Promise<string | null> {
  const row = await trx
    .selectFrom('health_reports')
    .select('id')
    .where('client_id', '=', clientId)
    .orderBy('report_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function reportOfClient(
  trx: TenantTransaction,
  reportId: string,
  clientId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('health_reports')
    .select('id')
    .where('id', '=', reportId)
    .where('client_id', '=', clientId)
    .executeTakeFirst();
  return Boolean(row);
}

/** 每项指标最多带几次之前的数值 */
const PREVIOUS_VALUES = 3;

/**
 * 这份报告的全部当前指标（含未收录指标），以及之前已核对报告里同一指标、同一单位的数值（规格 4.2）。
 * 高低标记用核对时后端按报告参考范围算好的结果（Q10），不重新判断。
 */
async function reportDetail(
  trx: TenantTransaction,
  clientId: string,
  reportId: string,
  reportDate: string,
): Promise<ReportDetail> {
  const rows = await trx
    .selectFrom('report_indicators')
    .select([
      'code',
      'raw_name',
      'value',
      'original_value',
      'unit',
      'ref_low',
      'ref_high',
      'ref_text',
      'abnormal',
    ])
    .where('report_id', '=', reportId)
    .where('superseded_by', 'is', null)
    .orderBy((eb) => eb('code', 'is', null))
    .orderBy('code')
    .orderBy('raw_name')
    .execute();
  const earlier = await trx
    .selectFrom('health_reports')
    .select((eb) => ['id', isoDateOf(eb, 'report_date').as('date')])
    .where('client_id', '=', clientId)
    .where('id', '<>', reportId)
    .where('report_date', '<', asDate(reportDate))
    .orderBy('report_date')
    .execute();
  const codes = rows.flatMap((r) => (r.code ? [r.code] : []));
  const previousRows =
    earlier.length && codes.length
      ? await trx
          .selectFrom('report_indicators as i')
          .innerJoin('health_reports as r', 'r.id', 'i.report_id')
          .select((eb) => [
            'i.code',
            'i.value',
            'i.unit',
            isoDateOf(eb, 'r.report_date').as('date'),
          ])
          .where('r.client_id', '=', clientId)
          .where(
            'r.id',
            'in',
            earlier.map((e) => e.id),
          )
          .where('i.superseded_by', 'is', null)
          .where('i.code', 'in', codes)
          .where('i.value', 'is not', null)
          .orderBy('r.report_date')
          .orderBy('r.created_at')
          .execute()
      : [];
  const num = (v: string | number | null) => (v === null ? null : Number(v));
  const indicators: ReportIndicatorDetail[] = rows.map((r) => ({
    code: r.code,
    rawName: r.code ? null : r.raw_name,
    value: num(r.value),
    textValue: r.value === null ? r.original_value : null,
    unit: r.unit || null,
    refText: r.ref_text,
    refLow: num(r.ref_low),
    refHigh: num(r.ref_high),
    abnormal: r.abnormal,
    // 只比较同一指标、同一单位的已核对数值
    previous: r.code
      ? previousRows
          .filter((p) => p.code === r.code && p.unit === r.unit && p.value !== null)
          .map((p) => ({ date: p.date, value: Number(p.value) }))
          .slice(-PREVIOUS_VALUES)
      : [],
  }));
  return { date: reportDate, indicators, previousReportDates: earlier.map((e) => e.date) };
}

/** 健康史（未删除的），文字由生成服务在组装提示词前脱敏 */
async function healthHistory(
  trx: TenantTransaction,
  clientId: string,
): Promise<HealthHistoryEntry[]> {
  const rows = await trx
    .selectFrom('client_health_history')
    .select(['category', 'content'])
    .where('client_id', '=', clientId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(100)
    .execute();
  return rows;
}

async function currentTier(
  trx: TenantTransaction,
  clientId: string,
): Promise<NonNullable<ClientSnapshot['riskTier']> | null> {
  const row = await trx
    .selectFrom('client_risk_tiers')
    .select((eb) => ['tier', isoDateOf(eb, 'set_at').as('set_on')])
    .where('client_id', '=', clientId)
    .orderBy('set_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { tier: row.tier, setOn: row.set_on } : null;
}

/** 日期列按 YYYY-MM-DD 文本取出，不经过 JS Date，避免时区把日期挪一天 */
function isoDateOf<D, TB extends keyof D>(
  eb: ExpressionBuilder<D, TB>,
  column: Parameters<ExpressionBuilder<D, TB>['ref']>[0],
) {
  return eb.fn<string>('to_char', [eb.ref(column), eb.val('YYYY-MM-DD')]);
}
