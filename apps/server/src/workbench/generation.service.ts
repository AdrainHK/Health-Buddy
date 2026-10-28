import { Inject, Injectable, Logger } from '@nestjs/common';
import { GatewayError, unknownNumbers } from '@health-buddy/ai-engine';
import {
  EMERGENCY_NOTICE,
  EXPERTS,
  planSectionExperts,
  EXPERT_MENTION_NOTE,
  consultationDigest,
  detectEmergencyKeywords,
  expertMentions,
  expertName,
  getExpert,
  renderConsultationSections,
  renderOpinion,
  suggestExpert,
  type ExpertOpinion,
} from '@health-buddy/experts';
import {
  EXPERT_REUSE_WINDOW_MS,
  type ConsultationOrigin,
  type ConsultationTrigger,
  type ExpertConsultation,
  type Synthesis,
  type SynthesisStatus,
  type TaskMode,
  type TaskStep,
  type TaskStreamEvent,
  type TwinRef,
  planOptionsSchema,
  type PlanOptions,
} from '@health-buddy/shared';
import {
  ASK_NOTICE,
  askSystemPrompt,
  buildAskUserContent,
  buildSystemPrompt,
  CRISIS_HEADER,
  criticalNotice,
  detectCrisisKeywords,
  finalizeClientText,
  getSkill,
  greetClient,
  knownNumbers,
  redactAskClient,
  redactClientIdentity,
  twinFreeTexts,
  wordingCategories,
  skillUsesReport,
  suggestSkill,
  withAskNotice,
  type SkillDefinition,
  type WordingIssue,
  PLAN_SECTION_ZH,
  planFreeTexts,
  redactPlanContext,
} from '@health-buddy/skills';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import type { TenantContext } from '../db/database.js';
import {
  ConsultationService,
  expertRequestKey,
  type ConsultRun,
  type ExpertSteps,
} from '../experts/consultation.service.js';
import { ExpertQuotaExceeded, ExpertsRepository } from '../experts/experts.repository.js';
import { allergyTextsOf, exerciseRestriction, restrictExercise } from '@health-buddy/plan-library';
import { RISK_TIER_CRITERIA } from './risk-tier-criteria.js';
import {
  WorkbenchRepository,
  type ClientContext,
  type FollowUpContext,
  type RegenerationContext,
} from './workbench.repository.js';

export type Emit = (event: TaskStreamEvent) => void;

/** 生成过程中的环境：发给前端的事件、停止信号、保存前重新确认会话 */
export interface TurnIo {
  emit: Emit;
  signal: AbortSignal;
  /** 会话仍然有效（没有退出登录、账号没有停用） */
  sessionValid: () => Promise<boolean>;
}

type DoneReason = 'complete' | 'stopped' | 'refused' | 'error';
type ErrorKind =
  | 'not_configured'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error'
  | 'invalid_output'
  | 'wording_check_failed'
  | 'internal_error';

/** 流式回答期间多久把已生成的文本存一次库，刷新页面也能看到 */
const FLUSH_MS = 2000;

/** 问一问里专家全部未能回复时的固定提示（M3 规格 3.6），不生成替代回答 */
export const EXPERTS_UNAVAILABLE = '专家暂时无法回复，请稍后再试。';

/**
 * “请专家看看”按孪生项没有对应的专家时（如睡眠，M4 规格 2.6 之二第 4 条）的固定回答，
 * 不调用专家，不报错
 */
export const NO_TWIN_EXPERT =
  '目前没有负责这个方面的专家。可以在问一问里手动 @ 某位专家，或直接提问。';

/** 技能自动调用专家的选项（M3 规格 2.4、2.5） */
export interface SkillExpertOptions {
  trigger: Extract<ConsultationTrigger, 'skill_auto' | 'plan'>;
  forced: string[];
  excluded: string[];
}

/** 一次专家调用里已回复的意见，供 /体检解读 专业版和摘要使用 */
interface UsedConsultation {
  consultationId: string;
  opinions: { expertId: string; opinion: ExpertOpinion }[];
  synthesis: Synthesis | null;
  synthesisFailed: boolean;
  /** 关键词、任何一位专家或汇总标出的心理危机信号 */
  crisis: boolean;
  /** 关键词、任何一位专家或汇总标出的疑似急症信号 */
  emergency: boolean;
}

/** 直接给出专家意见的那一轮：任务、客户、依据的报告和挂执行步骤的回答 */
interface ExpertTurn {
  taskId: string;
  clientId: string | null;
  reportId?: string | null;
  assistantMessageId: string;
  /** 专家中心任务绑定的专家 */
  expertId: string | null;
}

/** 这一轮请哪些专家、怎么请 */
export interface ExpertAnswerPlan {
  /** 健管师的问题原文（组装提示词前去标识） */
  question: string;
  trigger: ConsultationTrigger;
  /** direct：直接请指定的专家；route：自动选择（重新请 /体检解读 的专家时） */
  mode: 'direct' | 'route';
  forced: string[];
  excluded: string[];
  bound: string | null;
  /** 重新请专家、补请专家时派生自哪次调用 */
  origin?: ConsultationOrigin | null;
  requestMessageId: string | null;
  /** 10 分钟内同样的请求复用上次的意见；重新请专家、补请专家时不复用 */
  reuse: boolean;
  maxExperts?: number;
  /**
   * “请专家看看”（M4 规格 2.6 之二）：针对的孪生项（有值时读孪生、按孪生项路由）、发起的跟进项、
   * 要不要用模型补充路由（健管师补充了问题文字时才用）
   */
  twinRefs?: readonly TwinRef[];
  followUpItemId?: string | null;
  modelRouting?: boolean;
}

type AnsweredCall = { expertId: string; opinion: ExpertOpinion; removed: number };

/** 已回复、有意见的专家 */
function answeredCalls(
  calls: readonly {
    expertId: string;
    status: string;
    opinion: ExpertOpinion | null;
    removedFindings: number;
  }[],
): AnsweredCall[] {
  return calls.flatMap((c) =>
    c.status === 'done' && c.opinion
      ? [{ expertId: c.expertId, opinion: c.opinion, removed: c.removedFindings }]
      : [],
  );
}

/**
 * 直接请专家的回答（M3 实现记录第 4 条）：一位专家时是这位专家的完整意见；
 * 多位时先写“专家意见汇总”“专家分歧”两节，再逐位列出意见。
 */
function renderExpertAnswer(
  answered: readonly AnsweredCall[],
  totalCalls: number,
  synthesis: Synthesis | null,
  synthesisStatus: SynthesisStatus | null,
  notices: { crisis: boolean; emergency: boolean },
): string {
  if (answered.length === 1 && totalCalls === 1) {
    const only = answered[0]!;
    return renderOpinion(only.opinion, {
      ...notices,
      expertId: only.expertId,
      removedFindings: only.removed,
    });
  }
  const sections = renderConsultationSections(synthesis, answered, expertName, {
    synthesisFailed: synthesisStatus === 'failed',
  });
  const each = answered.map(
    (a) =>
      `### ${expertName(a.expertId)}\n\n${renderOpinion(a.opinion, { ...notices, expertId: a.expertId, removedFindings: a.removed })}`,
  );
  return [sections, ...each].join('\n\n');
}

/** 疑似急症提示（写在最前面，和心理危机提示一样不依赖模型） */
const EMERGENCY_HEADER = `**疑似急症提示**：${EMERGENCY_NOTICE}\n\n`;

/** 专家意见、汇总里的危机和急症信号 */
function expertSignals(
  opinions: readonly { opinion: ExpertOpinion }[],
  synthesis: Synthesis | null,
): { crisis: boolean; emergency: boolean } {
  return {
    crisis: Boolean(synthesis?.crisisSignal) || opinions.some((o) => o.opinion.crisisSignal),
    emergency:
      Boolean(synthesis?.emergencySignal) || opinions.some((o) => o.opinion.emergencySignal),
  };
}

/**
 * 主智能体（M1 规格 7.1）：按模式分流。问一问直接回答；想一想先出计划；
 * 做一做调用健管师指定的技能，生成草稿。不自动选择技能，只给建议（Q5）。
 *
 * 日志只记类别和计数，不记客户数据、提示词和回答原文（红线 2）。
 */
@Injectable()
export class GenerationService {
  private readonly logger = new Logger('Workbench');

  constructor(
    private readonly repo: WorkbenchRepository,
    @Inject(LLM_GATEWAY) private readonly gateway: AppGateway,
    @Inject(RISK_TIER_CRITERIA) private readonly riskTierCriteria: string | null,
    private readonly consultation: ConsultationService,
    private readonly experts: ExpertsRepository,
  ) {}

  /**
   * 问一问里直接请专家（M3 规格 2.3、2.4）：@ 的专家和任务绑定的专家，不经过自动路由。
   * 10 分钟内同样的问题、同样的专家复用上次的意见（规格 3.7）。
   */
  async consultAnswer(
    ctx: TenantContext,
    turn: ExpertTurn & { managerMessageId?: string; twinRefs?: TwinRef[] },
    request: { content: string; expertRefs: string[] },
    io: TurnIo,
  ): Promise<void> {
    // 同时 @专家 和 @孪生项（M4 合规审核 T7）：专家同样拿到孪生资料，孪生项不丢；
    // 依据的孪生可能已经变了，不复用 10 分钟内的意见
    const twinRefs = turn.twinRefs ?? [];
    await this.expertAnswer(
      ctx,
      turn,
      {
        question: request.content,
        trigger: request.expertRefs.length ? 'mention' : 'expert_center',
        mode: 'direct',
        forced: [...new Set([...(turn.expertId ? [turn.expertId] : []), ...request.expertRefs])],
        excluded: [],
        bound: turn.expertId,
        requestMessageId: turn.managerMessageId ?? null,
        reuse: twinRefs.length === 0,
        ...(twinRefs.length ? { twinRefs } : {}),
      },
      io,
    );
  }

  /**
   * “请专家看看”（M4 规格 2.6 之二）：按孪生项涉及的指标自动选专家（@ 的专家一定请），
   * 专家拿到 M3 的去标识资料加孪生项的状态、依据、历史和预测。触发方式记为 twin，不复用 10 分钟内的意见；
   * 从跟进项发起时跟进项记“已请专家”，状态不变。危机、急症和免责提示和 M3 一样保留。
   */
  async twinConsultAnswer(
    ctx: TenantContext,
    turn: ExpertTurn & {
      managerMessageId: string;
      twinRefs: TwinRef[];
      followUpItemId: string | null;
    },
    request: { content: string; expertRefs: string[]; excludedExperts: string[]; typed: boolean },
    io: TurnIo,
  ): Promise<void> {
    const remaining = await this.consultation.remainingToday(ctx);
    await this.expertAnswer(
      ctx,
      turn,
      {
        question: request.content,
        trigger: 'twin',
        mode: 'route',
        forced: request.expertRefs,
        excluded: request.excludedExperts,
        bound: null,
        requestMessageId: turn.managerMessageId,
        reuse: false,
        maxExperts: Math.max(1, Math.min(remaining, 3)),
        twinRefs: turn.twinRefs,
        followUpItemId: turn.followUpItemId,
        modelRouting: request.typed,
      },
      io,
    );
  }

  /**
   * 重新请专家、补请专家（M3 规格 6.4）：按原调用的问题和报告再请一次，生成新的调用记录，
   * 回答写在一条新的回答里（和直接请专家一样渲染）。不复用 10 分钟内的意见。
   */
  async followUpAnswer(
    ctx: TenantContext,
    turn: FollowUpContext,
    plan: Omit<ExpertAnswerPlan, 'question' | 'requestMessageId' | 'reuse'>,
    io: TurnIo,
  ): Promise<void> {
    await this.expertAnswer(
      ctx,
      turn,
      { ...plan, question: turn.question, requestMessageId: turn.requestMessageId, reuse: false },
      io,
    );
  }

  /**
   * 直接给出专家意见的回答。回答由后端按意见结构确定性渲染，末尾固定拼接提示；
   * 专家全部未能回复时只给固定提示，不生成替代回答。
   */
  private async expertAnswer(
    ctx: TenantContext,
    turn: ExpertTurn,
    plan: ExpertAnswerPlan,
    io: TurnIo,
  ): Promise<void> {
    const messageId = turn.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    // 危机和急症关键词在最前面自己识别，不依赖专家调用：调用没发起、全部失败或出错时也要提示健管师
    let signals = { crisis: false, emergency: false };
    // 读到客户档案后，危急指标提醒固定拼在回答开头（和问一问一样，不依赖专家怎么写）
    let critical = '';
    const signalHeaders = () =>
      (signals.crisis ? CRISIS_HEADER : '') + (signals.emergency ? EMERGENCY_HEADER : '');
    const notices = () => signalHeaders() + critical;
    try {
      const earlierTexts = await this.repo.managerTexts(ctx, turn.taskId);
      const signalTexts = [plan.question, ...earlierTexts];
      signals = {
        crisis: detectCrisisKeywords(signalTexts),
        emergency: detectEmergencyKeywords(signalTexts),
      };
      const client = turn.clientId
        ? await this.readClient(ctx, turn.clientId, steps, turn.reportId ?? null, true)
        : undefined;
      if (turn.clientId && !client) {
        const headers = signalHeaders();
        if (headers) io.emit({ type: 'text', messageId, delta: headers });
        return await this.finish(ctx, messageId, headers, 'error', io, 'internal_error');
      }
      // “请专家看看”：再读孪生（正在读取数字孪生），孪生项作为这次的关注点
      const twinRefs = plan.twinRefs ?? [];
      if (client && turn.clientId && twinRefs.length) {
        const twin = await this.readTwin(ctx, turn.clientId, twinRefs, steps);
        if (!twin) {
          const headers = signalHeaders();
          if (headers) io.emit({ type: 'text', messageId, delta: headers });
          return await this.finish(ctx, messageId, headers, 'error', io, 'internal_error');
        }
        client.snapshot = { ...client.snapshot, twin };
        // 手动调整理由、跟进备注里的危机和急症字样也算（原文识别，M4 规格 5.4 第 7 条）
        const twinTexts = twinFreeTexts(twin);
        signals = {
          crisis: signals.crisis || detectCrisisKeywords(twinTexts),
          emergency: signals.emergency || detectEmergencyKeywords(twinTexts),
        };
      }
      critical = client ? criticalNotice(client.snapshot.criticalFlags) : '';
      const run = {
        taskId: turn.taskId,
        messageId,
        clientId: turn.clientId,
        reportId: client?.report?.id ?? null,
        trigger: plan.trigger,
        mode: plan.mode,
        forced: plan.forced,
        excluded: plan.excluded,
        bound: plan.bound,
        origin: plan.origin ?? null,
        requestMessageId: plan.requestMessageId,
        ...(plan.maxExperts !== undefined ? { maxExperts: plan.maxExperts } : {}),
        ...(twinRefs.length
          ? {
              twinRefs,
              followUpItemId: plan.followUpItemId ?? null,
              modelRouting: plan.modelRouting ?? true,
            }
          : {}),
      };

      // 10 分钟内同样的请求：沿用上次的意见，不再调用模型（规格 3.7）
      // 这次关键词识别出、上次调用没有记下的危机或急症信号：不沿用，重新请专家（提示要跟着调用记录走）
      const found = plan.reuse
        ? await this.recentConsultation(ctx, { ...run, question: plan.question })
        : undefined;
      const recent =
        found &&
        (!signals.crisis || consultationCrisis(found)) &&
        (!signals.emergency || consultationEmergency(found))
          ? found
          : undefined;
      if (recent) {
        const answered = answeredCalls(recent.calls);
        await steps.reuseRecent(
          answered.map((a) => a.expertId),
          recent.createdAt,
          recent.id,
        );
        signals = {
          crisis: signals.crisis || consultationCrisis(recent),
          emergency: signals.emergency || consultationEmergency(recent),
        };
        // 危机、急症提示不依赖回答正文（规格 7.2 第 5 条）：和新调用一样通过 consultation 事件置顶
        io.emit({
          type: 'consultation',
          consultationId: recent.id,
          status: recent.status,
          crisisSignal: signals.crisis,
          emergencySignal: signals.emergency,
        });
        const text = `${critical}${renderExpertAnswer(
          answered,
          recent.calls.length,
          recent.synthesis,
          recent.synthesisStatus,
          signals,
        )}`;
        if (!(await io.sessionValid()))
          return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
        io.emit({ type: 'text', messageId, delta: text });
        return await this.finish(ctx, messageId, text, 'complete', io);
      }

      const outcome = await this.consultation.consult(
        ctx,
        {
          ...run,
          source: {
            client: client?.snapshot ?? null,
            question: plan.question,
            identifiers: client?.identifiers ?? [],
            earlierTexts,
            ...(twinRefs.length ? { twinRefs } : {}),
          },
        },
        { emit: io.emit, signal: io.signal, steps: steps.forExperts() },
      );
      signals = {
        crisis: signals.crisis || Boolean(outcome?.crisisDetected),
        emergency: signals.emergency || Boolean(outcome?.emergencyDetected),
      };
      if (io.signal.aborted || outcome?.result.status === 'stopped')
        throw new GatewayError('aborted');
      const answered = answeredCalls(outcome?.result.calls ?? []);
      // 孪生项没有对应的专家（如睡眠）：固定回答，提示可以手动 @ 专家，不算出错
      if (twinRefs.length && outcome && !outcome.result.routing.selected.length) {
        const text = `${notices()}${NO_TWIN_EXPERT}`;
        io.emit({ type: 'text', messageId, delta: text });
        return await this.finish(ctx, messageId, text, 'complete', io);
      }
      if (!outcome || !answered.length) {
        // 专家都没回复（或调用没有发起）也要把危机和急症提示留给健管师（关键词识别不依赖模型）
        const text = `${notices()}${EXPERTS_UNAVAILABLE}`;
        io.emit({ type: 'text', messageId, delta: text });
        return await this.finish(ctx, messageId, text, 'complete', io);
      }
      const text = `${critical}${renderExpertAnswer(
        answered,
        outcome.result.calls.length,
        outcome.result.synthesis,
        outcome.result.synthesisStatus,
        signals,
      )}`;
      if (!(await io.sessionValid()))
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      io.emit({ type: 'text', messageId, delta: text });
      await this.finish(ctx, messageId, text, 'complete', io);
    } catch (err) {
      await steps.failRunning();
      // 出错时同样保留危机和急症提示
      const headers = signalHeaders();
      if (headers && !io.signal.aborted) io.emit({ type: 'text', messageId, delta: headers });
      await this.fail(ctx, messageId, headers, err, io);
    }
  }

  /**
   * 10 分钟内可以复用的上一次调用（规格 3.7）：同一任务、同一位客户、同一份报告（之后没有更正）、
   * 同样的专家请求和问题原文，全部专家都已回复；参与的专家仍然可用、版本没有变。
   */
  private async recentConsultation(
    ctx: TenantContext,
    q: Pick<
      ConsultRun,
      | 'taskId'
      | 'clientId'
      | 'reportId'
      | 'trigger'
      | 'skillId'
      | 'mode'
      | 'forced'
      | 'excluded'
      | 'sectionHits'
    > & {
      bound?: string | null;
      question: string;
    },
  ): Promise<ExpertConsultation | undefined> {
    const found = await this.experts.findReusable(ctx, {
      taskId: q.taskId,
      clientId: q.clientId,
      reportId: q.reportId,
      requestKey: expertRequestKey(q),
      question: q.question,
      since: new Date(Date.now() - EXPERT_REUSE_WINDOW_MS),
    });
    if (!found?.calls.length) return undefined;
    const available = await this.consultation.availableIds(ctx);
    const current = found.calls.every(
      (c) => available.has(c.expertId) && getExpert(c.expertId)?.meta.version === c.expertVersion,
    );
    return current ? found : undefined;
  }

  /** 问一问，或想一想、做一做里没有选技能时：直接回答 */
  async answer(
    ctx: TenantContext,
    turn: {
      taskId: string;
      clientId: string | null;
      reportId?: string | null;
      assistantMessageId: string;
      managerMessageId: string;
      /** @ 引用的孪生项（M4 规格 2.8），回答以它们为主 */
      twinRefs?: readonly TwinRef[];
    },
    request: { mode: TaskMode; content: string },
    io: TurnIo,
  ): Promise<void> {
    const messageId = turn.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    let text = '';
    let lastFlush = Date.now();
    const push = (delta: string) => {
      text += delta;
      io.emit({ type: 'text', messageId, delta });
    };
    try {
      const client = turn.clientId
        ? await this.readClient(ctx, turn.clientId, steps, turn.reportId ?? null)
        : undefined;
      if (turn.clientId && !client)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      // M4 规格 2.9：读档案时一并读孪生（正在读取数字孪生），状态和预测作为档案的一部分
      const twin =
        client && turn.clientId
          ? await this.readTwin(ctx, turn.clientId, turn.twinRefs ?? [], steps)
          : undefined;
      if (client && !twin)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');

      const step = await steps.start('answer', 'steps.answer');
      const redact = (t: string) => redactClientIdentity(t, client?.identifiers ?? []);
      // 手动调整的理由、跟进备注也去标识（M4 规格 5.4 第 6 条）
      const snapshot = client
        ? redactAskClient({ ...client.snapshot, twin: twin ?? null }, redact)
        : undefined;
      // 历史消息也去标识：之前几轮里健管师可能提到过姓名或手机号
      const history = (await this.repo.history(ctx, turn.taskId, turn)).map((m) => ({
        ...m,
        content: redact(m.content),
      }));
      const question = redact(request.content);
      const userContent = buildAskUserContent(snapshot, question);

      // 固定的提醒由后端拼在开头，不依赖模型；模型拒答时也保留
      // 孪生里手动调整理由、跟进备注的原文（去标识之前）也算（M4 规格 5.4 第 7 条）
      const signalTexts = [
        request.content,
        ...(await this.repo.managerTexts(ctx, turn.taskId)),
        ...twinFreeTexts(twin),
      ];
      const crisis = detectCrisisKeywords(signalTexts);
      const emergency = detectEmergencyKeywords(signalTexts);
      const notices =
        (crisis ? CRISIS_HEADER : '') +
        (emergency ? EMERGENCY_HEADER : '') +
        (client ? criticalNotice(client.snapshot.criticalFlags) : '');
      push(notices);

      let finishReason: 'complete' | 'truncated' | 'refused' = 'complete';
      for await (const event of this.gateway.stream(
        ctx,
        {
          route: 'chat',
          system: askSystemPrompt(snapshot),
          messages: [...history, { role: 'user', content: userContent }],
          maxOutputTokens: 4000,
        },
        io.signal,
      )) {
        if (event.type === 'text') {
          push(event.delta);
          if (Date.now() - lastFlush > FLUSH_MS) {
            lastFlush = Date.now();
            await this.repo.saveAssistant(ctx, messageId, withAskNotice(text), 'streaming');
          }
        } else finishReason = event.finishReason;
      }
      if (finishReason === 'refused') {
        // 模型生成的部分丢掉（前端收到 refused 后清空已显示的文本），固定提醒留下
        await steps.finish(step, 'failed');
        return await this.finish(ctx, messageId, withAskNotice(notices), 'refused', io);
      }
      // 保存前重新确认会话（退出登录、停用、调岗都算失效）
      if (io.signal.aborted) throw new GatewayError('aborted');
      if (!(await io.sessionValid())) {
        await steps.finish(step, 'failed');
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      }
      const final = withAskNotice(text);
      if (final) io.emit({ type: 'text', messageId, delta: `\n\n${ASK_NOTICE}` });
      await steps.finish(step, 'done');
      const suggestion = suggestSkill(request.content);
      if (suggestion) io.emit({ type: 'suggestion', skillId: suggestion });
      // 主对话的问一问不自动请专家，问题明显属于某位专家时只建议“请 @某专家 看看”（Q6）。
      // 有危机或急症信号时不建议：健管师应先按提示处理，不把它当成一般的专业问题（M3 合规审查）
      if (
        request.mode === 'ask' &&
        this.consultation.preview &&
        !crisis &&
        !detectEmergencyKeywords(signalTexts)
      ) {
        const expertId = suggestExpert(request.content, await this.consultation.availableIds(ctx));
        if (expertId) io.emit({ type: 'expert_suggestion', expertId });
      }
      await this.finish(ctx, messageId, final, 'complete', io);
    } catch (err) {
      await steps.failRunning();
      await this.fail(ctx, messageId, withAskNotice(text), err, io);
    }
  }

  /**
   * 想一想：先出计划，等健管师确认（规格 3.3）。计划是“读档案”加上按顺序调用的技能；
   * 多步计划（Q22）如“新客户完整评估”= 读档案 → /体检解读 → /面谈提纲。
   */
  async propose(
    ctx: TenantContext,
    turn: { assistantMessageId: string },
    skillIds: string[],
    io: TurnIo,
  ): Promise<void> {
    try {
      // 读孪生的技能（/孪生小结、孪生复盘）：读档案 → 读数字孪生 → 技能
      // M5 方案和随访技能同样先读孪生（规格 2.7）
      const readsTwin = skillIds.some((id) => getSkill(id)?.usesTwin || getSkill(id)?.planContext);
      const plan = await this.repo.createPlan(ctx, turn.assistantMessageId, [
        { kind: 'read_client' },
        ...(readsTwin ? [{ kind: 'read_twin' as const }] : []),
        ...skillIds.map((skillId) => ({ kind: 'run_skill' as const, skillId })),
      ]);
      io.emit({ type: 'plan', plan });
      await this.finish(ctx, turn.assistantMessageId, '', 'complete', io);
    } catch (err) {
      await this.fail(ctx, turn.assistantMessageId, '', err, io);
    }
  }

  /**
   * 做一做：执行技能，生成草稿（也用于确认计划后执行、退回后重写）。
   * 多步计划（Q22）按顺序执行多个技能，每个技能各出一份草稿；某一步没有生成草稿时停止，不再往下执行。
   */
  async runSkill(
    ctx: TenantContext,
    run: Omit<RegenerationContext, 'skillIds' | 'reportId'> & {
      skills: SkillDefinition[];
      returnReason?: string;
      reportId?: string | null;
      /** 技能自动调用专家（M3，只在预览开关打开时生效） */
      experts?: SkillExpertOptions;
      /** 退回重写时重新请专家，不复用上一版的意见（Q21） */
      reconsult?: boolean;
    },
    io: TurnIo,
  ): Promise<void> {
    const messageId = run.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    try {
      if (!run.clientId || !run.skills.length)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      const usesReport = run.skills.some(skillUsesReport);
      const usesTwin = run.skills.some((s) => s.usesTwin);
      // M5 方案和随访技能：读档案 → 读数字孪生 → 读当前方案（→ 选库条目 → 排随访日期）；
      // “方案和随访”计划两步都有，一次读齐
      const planKinds = [
        ...new Set(run.skills.flatMap((s) => (s.planContext ? [s.planContext] : []))),
      ];
      const client = planKinds.length
        ? await this.readPlanClient(ctx, run.clientId, steps, planKinds, run.planOptions ?? null, {
            materialIds: run.materialIds ?? [],
            visitId: run.visitId ?? null,
          })
        : usesTwin
          ? await this.readTwinClient(ctx, run.clientId, steps)
          : usesReport
            ? await this.readReport(ctx, run.clientId, steps, run.reportId ?? null, run.skills)
            : await this.readClient(ctx, run.clientId, steps, run.reportId ?? null);
      if (!client) return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');

      // 心理危机和疑似急症信号不只依赖模型判断：健管师的原话、退回原因、本任务之前的消息里有关键词也算
      // 孪生小结、孪生复盘：手动调整理由、跟进备注的原文也算（M4 规格 5.4 第 7 条）
      const signalTexts = [
        run.managerRequest,
        run.returnReason ?? '',
        ...(await this.repo.managerTexts(ctx, run.taskId)),
        ...twinFreeTexts(client.snapshot.twin),
        ...planFreeTexts(client.plan),
        // 方案和随访技能：健康史里写的危机、急症描述也算（M5 规格 5.4 第 7 条）
        ...(client.plan ? (client.snapshot.healthHistory ?? []).map((h) => h.content) : []),
      ];
      const crisis = detectCrisisKeywords(signalTexts);
      const emergencyKeywords = detectEmergencyKeywords(signalTexts);
      // 运动安全规则（Q8）：有疑似急症信号时运动部分同样只写“先就医评估”
      if (emergencyKeywords && client.plan?.library && !client.plan.library.exerciseRestriction) {
        client.plan = {
          ...client.plan,
          library: restrictExercise(client.plan.library, '有疑似急症信号'),
        };
      }
      const redact = (t: string) => redactClientIdentity(t, client.identifiers);
      const snapshot = {
        ...client.snapshot,
        // 健康史是健管师写的自由文字，可能带姓名或联系方式，组装前同样脱敏（规格 4.2）
        ...(client.snapshot.healthHistory
          ? {
              healthHistory: client.snapshot.healthHistory.map((h) => ({
                ...h,
                content: redact(h.content),
              })),
            }
          : {}),
      };
      // 孪生里手动调整的理由、跟进备注同样去标识（M4 规格 5.4 第 6 条）
      const redactedSnapshot = redactAskClient(snapshot, redact);
      const input = {
        client: redactedSnapshot,
        managerRequest: redact(run.managerRequest),
        returnReason: run.returnReason === undefined ? undefined : redact(run.returnReason),
        riskTierCriteria: this.riskTierCriteria,
        ...(client.plan ? { plan: redactPlanContext(client.plan, redact) } : {}),
      };

      for (const skill of run.skills) {
        // M3：接入专家的技能（/体检解读）先请专家，预览开关关闭时和 M2 完全一样
        const used =
          skill.experts === 'auto' && this.consultation.preview
            ? await this.skillConsultation(ctx, run, skill.id, client, steps, io)
            : undefined;
        if (io.signal.aborted) throw new GatewayError('aborted');
        // 疑似急症：关键词，或专家、汇总标出的信号（和危机信号一样各自识别，再取“或”）
        const emergency = emergencyKeywords || Boolean(used?.emergency);
        // /方案生成：专家标了急症信号或“需尽快就医”的转介时，运动部分同样只写“先就医评估”（规格 2.5）
        const urgentReferral = Boolean(
          used?.opinions.some((o) => o.opinion.referral.urgency === 'urgent'),
        );
        const library = input.plan?.library;
        const planInput =
          library && !library.exerciseRestriction && (emergency || urgentReferral)
            ? {
                ...input,
                plan: {
                  ...input.plan!,
                  library: restrictExercise(
                    library,
                    urgentReferral ? '专家建议尽快就医' : '有疑似急症信号',
                  ),
                },
              }
            : input;
        const skillInput = used
          ? { ...planInput, expertDigest: consultationDigest(used.opinions, expertName) }
          : planInput;
        const crisisSignal = crisis || Boolean(used?.crisis);
        const step = await steps.start('run_skill', skill.runStepLabel ?? 'steps.runSkill');
        const userMessage = skill.buildUserMessage(skillInput);
        const call = (content: string) =>
          this.gateway.completeStructured(
            ctx,
            {
              // 规格 4.1：/体检解读 用已登记的 report_interpretation 用途，其他技能用 skill 用途
              route: skill.route ?? 'skill',
              system: buildSystemPrompt(skill),
              messages: [{ role: 'user', content }],
              maxOutputTokens: 8000,
            },
            { name: skill.id.replace(/-/g, '_'), schema: skill.outputSchema },
            io.signal,
          );
        let result = await call(userMessage);
        // 保存前的确定性措辞检查（/面谈提纲，规格 2.8）：没通过就带着纠正说明重新生成一次，
        // 仍没通过就不保存草稿。日志只记类别和次数，不记输出内容。
        // M3：用了专家意见时，通俗版里不能出现“专家”和专家名称（合规审查第 4 条），同样重试一次
        const check = (data: unknown) => {
          const wording: WordingIssue[] = [
            ...(skill.checkOutput?.(data as never, skillInput) ?? []),
          ];
          // 读孪生的技能：说明文字里的数值只能来自输入资料，不能自己推算（M4 规格 2.7、5.2）
          if (skill.numberCheckTexts) {
            const allowed = knownNumbers(skillInput.client, [
              skillInput.managerRequest,
              skillInput.returnReason ?? '',
            ]);
            const invented = unknownNumbers(
              skill.numberCheckTexts(data as never).join('\n'),
              allowed,
            );
            if (invented.length) wording.push({ category: 'invented_number', term: '', index: 0 });
          }
          const clientFacing = (data as { clientFacing?: unknown }).clientFacing;
          const clientTexts =
            skill.clientFacingTexts?.(data as never) ??
            (typeof clientFacing === 'string' ? [clientFacing] : []);
          // /方案生成：没请专家时通俗版同样不能出现“专家”和专家名称（规格 5.3）
          const mentions =
            (used || skill.planContext === 'care_plan') && skill.clientFacing
              ? clientTexts.flatMap((text) =>
                  expertMentions(
                    text,
                    EXPERTS.map((e) => e.meta.name),
                  ),
                )
              : [];
          // M5：结构校验（随访日期和输入一致、条目在候选里、参数在范围里），只记类别
          const invalid = skill.validateOutput?.(data as never, skillInput) ?? [];
          const categories: string[] = [
            ...wordingCategories(wording),
            ...(mentions.length ? ['expert_mention'] : []),
            ...invalid,
          ];
          return { wording, mentions, invalid, categories };
        };
        let issues = result.status === 'ok' ? check(result.data) : undefined;
        if (issues?.categories.length) {
          this.logger.warn(
            `output check failed ${JSON.stringify({ skill: skill.id, attempt: 1, categories: issues.categories })}`,
          );
          const note = [
            issues.wording.length ? (skill.correctionNote?.(issues.wording) ?? '') : '',
            issues.mentions.length ? EXPERT_MENTION_NOTE : '',
            issues.invalid.length ? (skill.validationNote?.(issues.invalid) ?? '') : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          result = await call(note ? `${userMessage}\n\n${note}` : userMessage);
          issues = result.status === 'ok' ? check(result.data) : undefined;
          if (issues?.categories.length) {
            this.logger.warn(
              `output check failed ${JSON.stringify({ skill: skill.id, attempt: 2, categories: issues.categories })}`,
            );
            await steps.finish(step, 'failed');
            const notices =
              (crisisSignal ? CRISIS_HEADER : '') +
              (emergency ? EMERGENCY_HEADER : '') +
              criticalNotice(client.snapshot.criticalFlags);
            return await this.finish(ctx, messageId, notices, 'error', io, 'wording_check_failed');
          }
        }
        if (result.status === 'refused') {
          // 没有产物，但危机、急症和危急指标提醒要留给健管师
          await steps.finish(step, 'failed');
          const notices =
            (crisisSignal ? CRISIS_HEADER : '') +
            (emergency ? EMERGENCY_HEADER : '') +
            criticalNotice(client.snapshot.criticalFlags);
          return await this.finish(ctx, messageId, withAskNotice(notices), 'refused', io);
        }
        const output = result.data as Record<string, unknown>;
        // 心理危机：关键词，或专家、汇总标出的信号（合规审查第 2 条）
        if (crisisSignal) output.crisisSignal = true;
        const rendered = skill.render(output, skillInput);
        // 专家意见汇总和分歧由后端确定性写进专业版，绝不进通俗版（M3 规格 2.7）；
        // 疑似急症提示放在专业版最前面
        const professional =
          (emergency ? EMERGENCY_HEADER : '') +
          (used
            ? `${rendered.professional}\n\n${renderConsultationSections(used.synthesis, used.opinions, expertName, { synthesisFailed: used.synthesisFailed })}`
            : // /方案生成 没请专家（预览关闭、次数用完）时写明（规格 2.5）
              skill.planContext === 'care_plan'
              ? `${rendered.professional}\n\n本次未调用专家。`
              : rendered.professional);

        // 保存前重新确认：会话仍然有效、任务没有断开、客户仍归当前健管师
        if (io.signal.aborted) throw new GatewayError('aborted');
        if (!(await io.sessionValid())) {
          await steps.finish(step, 'failed');
          return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
        }
        const artifact = await this.repo.saveArtifact(ctx, run.taskId, run.clientId, {
          skillId: skill.id,
          kind: skill.kind,
          professional,
          clientFacing: skill.clientFacing
            ? finalizeClientText(greetClient(client.displayName, rendered.clientFacing))
            : '',
          criticalFlags: client.snapshot.criticalFlags,
          // 多步计划里只有第一步是“基于这一版修改”，其余都是新的产物
          parent: run.skills.length === 1 ? run.parent : undefined,
          sourceReportId: skillUsesReport(skill) ? (client.report?.id ?? null) : null,
          riskTierSuggestion: rendered.riskTierSuggestion ?? null,
          consultationId: used?.consultationId ?? null,
          emergencySignal: emergency,
          // 模型自己标出的危机信号也要让审核栏醒目提示（M5 规格 2.9 第 5 条）
          crisisSignal: crisisSignal || rendered.crisisSignal,
          ...(rendered.structured === undefined ? {} : { structured: rendered.structured }),
          ...(skill.planContext === 'care_plan'
            ? { planOptions: client.plan?.library?.options ?? planOptionsSchema.parse({}) }
            : {}),
          // 随访话术、随访记录关联的那一次随访；记录还要记下整理的素材（确认后 30 天删除原文）
          ...((skill.planContext === 'visit_script' || skill.planContext === 'visit_record') &&
          run.visitId
            ? { visitId: run.visitId }
            : {}),
          ...(skill.usesMaterials && run.materialIds?.length
            ? { materialIds: run.materialIds }
            : {}),
        });
        if (!artifact) {
          await steps.finish(step, 'failed');
          return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
        }
        await steps.finish(step, 'done');
        io.emit({ type: 'artifact', artifact });
        this.logger.log(
          `artifact drafted ${JSON.stringify({
            skill: skill.id,
            criticalFlags: client.snapshot.criticalFlags.length,
            urgent: client.snapshot.criticalFlags.filter((f) => f.rule.level === 'urgent').length,
            riskTierSuggested: Boolean(rendered.riskTierSuggestion),
            experts: used?.opinions.length ?? 0,
          })}`,
        );
      }
      await this.finish(ctx, messageId, '', 'complete', io);
    } catch (err) {
      await steps.failRunning();
      await this.fail(ctx, messageId, '', err, io);
    }
  }

  /**
   * 技能的专家调用（M3 规格 2.5）：退回重写默认复用上一版的专家意见（Q21），健管师要求重新请、
   * 或依据的报告数值之后被更正过时重新请（沿用上一版的“一定要请”“不要请”）；
   * 10 分钟内同样的请求复用上次的意见（规格 3.7）；否则自动路由。
   * 当天专家调用次数用完时不请专家，技能照常生成（Q12）。
   */
  private async skillConsultation(
    ctx: TenantContext,
    run: {
      taskId: string;
      clientId: string | null;
      managerRequest: string;
      assistantMessageId: string;
      reuseConsultationId?: string | null;
      requestMessageId?: string | null;
      experts?: SkillExpertOptions;
      reconsult?: boolean;
    },
    skillId: string,
    client: ClientContext,
    steps: StepRunner,
    io: TurnIo,
  ): Promise<UsedConsultation | undefined> {
    let options = run.experts ?? { trigger: 'skill_auto' as const, forced: [], excluded: [] };
    let origin: ConsultationOrigin | null = null;
    // M5 /方案生成：按方案部分命中专家，问题是“就这位客户的【饮食 / 运动】方案给出要点和注意事项”（规格 2.5）
    const planSections = client.plan?.library?.options.sections;
    const sectionHits = planSections
      ? planSectionExperts(planSections, [
          run.managerRequest,
          ...(client.snapshot.healthHistory ?? []).map((h) => h.content),
          ...planFreeTexts(client.plan),
        ])
      : [];
    const question = planSections
      ? [
          `请就这位客户的【${planSections.map((s) => PLAN_SECTION_ZH[s]).join(' / ')}】方案给出要点和注意事项。`,
          run.managerRequest.trim() ? `健管师的要求：${run.managerRequest.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : run.managerRequest;
    const reuse = async (
      previous: ExpertConsultation,
      labelKey: string,
      labelTime: Date | null,
    ): Promise<UsedConsultation> => {
      const opinions = previous.calls.flatMap((c) =>
        c.status === 'done' && c.opinion ? [{ expertId: c.expertId, opinion: c.opinion }] : [],
      );
      const step = await steps.start(
        'consult_experts',
        labelKey,
        opinions.map((o) => o.expertId),
        labelTime,
        previous.id,
      );
      await steps.finish(step, 'done');
      const signals = expertSignals(opinions, previous.synthesis);
      return {
        consultationId: previous.id,
        opinions,
        synthesis: previous.synthesis,
        synthesisFailed: previous.synthesisStatus === 'failed',
        crisis: signals.crisis || previous.crisisSignal,
        emergency:
          signals.emergency ||
          previous.emergencySignal ||
          detectEmergencyKeywords([
            run.managerRequest,
            ...(await this.repo.managerTexts(ctx, run.taskId)),
          ]),
      };
    };

    if (run.reuseConsultationId) {
      const previous = await this.experts.get(ctx, run.reuseConsultationId);
      if (previous && !run.reconsult && !previous.reportCorrectedSince) {
        return reuse(previous, 'steps.reuseExperts', null);
      }
      if (previous) {
        // 重新请专家：新的调用记录指向上一版的调用，沿用当时健管师的指定和排除
        origin = { kind: 'reconsult', consultationId: previous.id };
        options = await this.carriedOptions(ctx, previous);
      }
    }
    if (!origin && !run.reconsult) {
      const recent = await this.recentConsultation(ctx, {
        taskId: run.taskId,
        clientId: run.clientId,
        reportId: client.report?.id ?? null,
        trigger: options.trigger,
        skillId,
        mode: 'route',
        forced: options.forced,
        excluded: options.excluded,
        sectionHits,
        // 复用比较的是健管师消息原文（不是拼出来的问题）；方案部分已在请求键里
        question: run.managerRequest,
      });
      if (recent) return reuse(recent, 'steps.reuseRecentExperts', new Date(recent.createdAt));
    }
    const remaining = await this.consultation.remainingToday(ctx);
    if (remaining <= 0) {
      this.logger.warn('expert daily limit reached, skill runs without experts');
      return undefined;
    }
    const outcome = await this.consultation
      .consult(
        ctx,
        {
          taskId: run.taskId,
          messageId: run.assistantMessageId,
          clientId: run.clientId,
          reportId: client.report?.id ?? null,
          trigger: options.trigger,
          skillId,
          mode: 'route',
          forced: options.forced,
          excluded: options.excluded,
          ...(sectionHits.length ? { sectionHits } : {}),
          source: {
            client: client.snapshot,
            question,
            identifiers: client.identifiers,
            earlierTexts: await this.repo.managerTexts(ctx, run.taskId),
          },
          maxExperts: Math.min(remaining, 3),
          origin,
          requestMessageId: run.requestMessageId ?? null,
        },
        { emit: io.emit, signal: io.signal, steps: steps.forExperts() },
      )
      .catch((err: unknown) => {
        // 并发请求刚好用完了今天的专家调用次数：这次不请专家，技能照常生成（Q12）
        if (err instanceof ExpertQuotaExceeded) {
          this.logger.warn('expert daily limit reached, skill runs without experts');
          return undefined;
        }
        throw err;
      });
    if (!outcome) return undefined;
    if (outcome.result.status === 'stopped') throw new GatewayError('aborted');
    const opinions = outcome.result.calls.flatMap((c) =>
      c.status === 'done' && c.opinion ? [{ expertId: c.expertId, opinion: c.opinion }] : [],
    );
    const signals = expertSignals(opinions, outcome.result.synthesis);
    return {
      consultationId: outcome.consultationId,
      opinions,
      synthesis: outcome.result.synthesis,
      synthesisFailed: outcome.result.synthesisStatus === 'failed',
      crisis: signals.crisis || outcome.crisisDetected,
      emergency: signals.emergency || outcome.emergencyDetected,
    };
  }

  /**
   * 重新请专家时沿用上一次调用里健管师的选择：“一定要请”的专家（仍可用的）和“不要请”的专家。
   * 触发方式沿用技能自动调用或计划。
   */
  private async carriedOptions(
    ctx: TenantContext,
    previous: ExpertConsultation,
  ): Promise<SkillExpertOptions> {
    const available = await this.consultation.availableIds(ctx);
    return {
      trigger: previous.trigger === 'plan' ? 'plan' : 'skill_auto',
      forced: previous.routing.selected
        .filter((s) => s.reasons.some((r) => r.kind === 'manager') && available.has(s.expertId))
        .map((s) => s.expertId),
      excluded: previous.routing.excluded,
    };
  }

  /**
   * 用报告的技能读资料（规格 2.5 第 4 条）：正在读取报告（日期）→ 正在对比历次报告
   * →（/体检解读）正在识别危急指标。报告不见了（并发转出等）时失败，不退回到别的报告。
   * reportId 已在发消息、确认计划或退回时定好；为空只可能是报告可选的技能（/面谈提纲）
   * 而客户还没有已核对报告，这时只读档案（健康史、日常监测、分层）。
   */
  private async readReport(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
    reportId: string | null,
    skills: SkillDefinition[],
  ): Promise<ClientContext | undefined> {
    const required = skills.some((s) => s.requiresReport);
    if (reportId === null && !required) {
      const read = await steps.start('read_client', 'steps.readClient');
      const client = await this.repo.clientContext(ctx, clientId, null, {
        detail: true,
        latestReport: false,
      });
      if (!client) {
        await steps.finish(read, 'failed');
        return undefined;
      }
      await steps.finish(read, 'done');
      const detect = await steps.start('detect_critical', 'steps.detectCritical');
      await steps.finish(detect, 'done');
      return client;
    }
    const read = await steps.start('read_report', 'steps.readReport');
    const client = await this.repo.clientContext(ctx, clientId, reportId, {
      detail: true,
      latestReport: false,
    });
    if (!client?.report || !client.snapshot.reportDetail) {
      await steps.finish(read, 'failed');
      return undefined;
    }
    await steps.finish(read, 'done', client.report.date);
    if (skills.some((s) => s.id === 'report-interpretation')) {
      const compare = await steps.start('compare_reports', 'steps.compareReports');
      await steps.finish(compare, 'done');
    }
    const detect = await steps.start('detect_critical', 'steps.detectCritical');
    await steps.finish(detect, 'done');
    return client;
  }

  /** 正在读取数字孪生（M4 规格 2.9）：客户看不到时步骤失败，返回 undefined */
  private async readTwin(
    ctx: TenantContext,
    clientId: string,
    focus: readonly TwinRef[],
    steps: StepRunner,
  ) {
    const step = await steps.start('read_twin', 'steps.readTwin');
    const twin = await this.repo.twinContext(ctx, clientId, focus);
    await steps.finish(step, twin ? 'done' : 'failed');
    return twin;
  }

  /**
   * /孪生小结 读资料（M4 规格 2.7）：正在读取客户档案 → 正在读取数字孪生 → 正在计算趋势
   * （预测已由孪生计算好，这一步只取用）→ 正在识别危急指标
   */
  private async readTwinClient(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
  ): Promise<ClientContext | undefined> {
    const read = await steps.start('read_client', 'steps.readClient');
    const client = await this.repo.clientContext(ctx, clientId, null, { detail: true });
    if (!client) {
      await steps.finish(read, 'failed');
      return undefined;
    }
    await steps.finish(read, 'done');
    const twin = await this.readTwin(ctx, clientId, [], steps);
    if (!twin) return undefined;
    const forecast = await steps.start('compute_forecast', 'steps.computeForecast');
    await steps.finish(forecast, 'done');
    const detect = await steps.start('detect_critical', 'steps.detectCritical');
    await steps.finish(detect, 'done');
    return { ...client, snapshot: { ...client.snapshot, twin } };
  }

  /**
   * 方案和随访技能（M5 规格 2.7）：读档案 → 读数字孪生 → 读当前方案 → 排随访日期（/随访计划）→
   * 识别危急指标。客户看不到时步骤失败，返回 undefined
   */
  private async readPlanClient(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
    kinds: NonNullable<SkillDefinition['planContext']>[],
    planOptions: PlanOptions | null,
    visitRefs: { materialIds: readonly string[]; visitId: string | null } = {
      materialIds: [],
      visitId: null,
    },
  ): Promise<ClientContext | undefined> {
    const schedule = kinds.includes('visit_schedule');
    const makesPlan = kinds.includes('care_plan');
    const script = kinds.includes('visit_script');
    const record = kinds.includes('visit_record');
    // /随访记录：正在读取随访素材 → 正在读取客户档案 → 正在读取当前方案（不读孪生，规格 2.9）
    if (record) {
      const step = await steps.start('read_visit_materials', 'steps.readVisitMaterials');
      await steps.finish(step, 'done');
    }
    const read = await steps.start('read_client', 'steps.readClient');
    const client = await this.repo.clientContext(ctx, clientId, null, {
      detail: true,
      latestReport: false,
    });
    if (!client) {
      await steps.finish(read, 'failed');
      return undefined;
    }
    await steps.finish(read, 'done');
    const twin = record ? null : await this.readTwin(ctx, clientId, [], steps);
    if (twin === undefined) return undefined;
    const readPlan = await steps.start('read_care_plan', 'steps.readCarePlan');
    const options = planOptions ?? planOptionsSchema.parse({});
    const plan = await this.repo.planContext(ctx, clientId, {
      schedule,
      // 同一次计划先生成方案草稿：方案复评按草稿的周期排（2.10）
      ...(makesPlan && schedule ? { draftCycleWeeks: options.cycleWeeks } : {}),
      ...(makesPlan
        ? {
            library: {
              options,
              // 过敏史只在后端和库条目比对，不进日志（Q16）
              allergyTexts: allergyTextsOf(client.snapshot),
              restriction: exerciseRestriction(client.snapshot),
            },
          }
        : {}),
      // /随访话术：执行情况和下一次随访；/随访记录：关联的随访和素材
      ...(script ? { adherence: true } : {}),
      ...(script || record ? { visit: { visitId: visitRefs.visitId, nextOpen: script } } : {}),
      ...(record ? { materialIds: visitRefs.materialIds } : {}),
      riskTier: client.snapshot.riskTier?.tier ?? null,
      hasUrgentFollowUp: Boolean(twin?.followUps.some((f) => f.severity <= 2)),
      // 账号没设置时区时按北京时间（和确认随访计划时的日期校验一致）
      tzFallback: 'Asia/Shanghai',
    });
    await steps.finish(readPlan, 'done');
    if (script) {
      const step = await steps.start('read_visit_records', 'steps.readVisitRecords');
      await steps.finish(step, 'done');
    }
    if (makesPlan) {
      const step = await steps.start('select_library_items', 'steps.selectLibraryItems');
      await steps.finish(step, 'done');
    }
    if (schedule) {
      const step = await steps.start('schedule_visits', 'steps.scheduleVisits');
      await steps.finish(step, 'done');
    }
    const detect = await steps.start('detect_critical', 'steps.detectCritical');
    await steps.finish(detect, 'done');
    return { ...client, snapshot: { ...client.snapshot, ...(twin ? { twin } : {}) }, plan };
  }

  /** 读档案、识别危急指标，两步都推给前端 */
  private async readClient(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
    reportId: string | null = null,
    detail = false,
  ): Promise<ClientContext | undefined> {
    const read = await steps.start('read_client', 'steps.readClient');
    const client = await this.repo.clientContext(ctx, clientId, reportId, { detail });
    if (!client) {
      await steps.finish(read, 'failed');
      return undefined;
    }
    await steps.finish(read, 'done');
    const detect = await steps.start('detect_critical', 'steps.detectCritical');
    await steps.finish(detect, 'done');
    return client;
  }

  private async fail(
    ctx: TenantContext,
    messageId: string,
    text: string,
    err: unknown,
    io: TurnIo,
  ): Promise<void> {
    if (io.signal.aborted || (err instanceof GatewayError && err.kind === 'aborted')) {
      // 停止：已生成的文本保留，不生成产物（规格 3.2）
      return this.finish(ctx, messageId, text, 'stopped', io);
    }
    const kind = errorKind(err);
    if (kind === 'internal_error') {
      this.logger.error(`generation failed ${err instanceof Error ? err.name : typeof err}`);
    }
    await this.finish(ctx, messageId, text, 'error', io, kind);
  }

  private async finish(
    ctx: TenantContext,
    messageId: string,
    text: string,
    reason: DoneReason,
    io: TurnIo,
    error?: ErrorKind,
  ): Promise<void> {
    await this.repo.saveAssistant(ctx, messageId, text, reason);
    if (error) io.emit({ type: 'error', kind: error });
    io.emit({ type: 'done', messageId, reason });
  }
}

function errorKind(err: unknown): ErrorKind {
  // 每日专家调用次数在并发时用完：和限流一样提示稍后再试
  if (err instanceof ExpertQuotaExceeded) return 'rate_limited';
  if (err instanceof GatewayError) {
    switch (err.kind) {
      case 'not_configured':
      case 'rate_limited':
      case 'timeout':
      case 'provider_error':
      case 'invalid_output':
        return err.kind;
      default:
        return 'provider_error';
    }
  }
  return 'internal_error';
}

/** 执行步骤：写库并推给前端；出错时把还在进行的步骤标成失败 */
class StepRunner {
  private seq = 0;
  private readonly running = new Set<TaskStep>();

  constructor(
    private readonly repo: WorkbenchRepository,
    private readonly ctx: TenantContext,
    private readonly messageId: string,
    private readonly emit: Emit,
  ) {}

  async start(
    kind: TaskStep['kind'],
    labelKey: string,
    expertIds?: string[],
    labelTime: Date | null = null,
    consultationId: string | null = null,
  ): Promise<TaskStep> {
    const step = await this.repo.startStep(
      this.ctx,
      this.messageId,
      this.seq++,
      kind,
      labelKey,
      null,
      expertIds,
      labelTime,
      consultationId,
    );
    this.running.add(step);
    this.emit({ type: 'step', step });
    return step;
  }

  /** 已经结束的步骤不再重复结束（专家调用出错时会统一收尾） */
  async finish(step: TaskStep, status: 'done' | 'failed', labelDate?: string): Promise<void> {
    if (!this.running.delete(step)) return;
    const done = await this.repo.finishStep(this.ctx, step, status, labelDate);
    this.emit({ type: 'step', step: done });
  }

  /** “沿用 10:32 的专家意见”（规格 3.7）：一步就完成，步骤记下被沿用的调用（刷新后恢复危机、急症提示） */
  async reuseRecent(expertIds: string[], createdAt: string, consultationId: string): Promise<void> {
    const step = await this.start(
      expertIds.length === 1 ? 'consult_expert' : 'consult_experts',
      'steps.reuseRecentExperts',
      expertIds,
      new Date(createdAt),
      consultationId,
    );
    await this.finish(step, 'done');
  }

  forExperts(): ExpertSteps {
    return {
      start: (kind, labelKey, expertIds) => this.start(kind, labelKey, expertIds),
      finish: (step, status) => this.finish(step, status),
    };
  }

  async failRunning(): Promise<void> {
    for (const step of [...this.running]) {
      await this.finish(step, 'failed').catch(() => undefined);
    }
  }
}

/** 调用记录上的危机信号：记录本身、汇总或任何一位专家的意见（和工作台 consultationSignals 一致） */
function consultationCrisis(c: ExpertConsultation): boolean {
  return (
    c.crisisSignal ||
    Boolean(c.synthesis?.crisisSignal) ||
    c.calls.some((call) => Boolean(call.opinion?.crisisSignal))
  );
}

/** 调用记录上的急症信号 */
function consultationEmergency(c: ExpertConsultation): boolean {
  return (
    c.emergencySignal ||
    Boolean(c.synthesis?.emergencySignal) ||
    c.calls.some((call) => Boolean(call.opinion?.emergencySignal))
  );
}
