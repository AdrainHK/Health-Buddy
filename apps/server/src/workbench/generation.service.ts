import { Inject, Injectable, Logger } from '@nestjs/common';
import { GatewayError } from '@health-buddy/ai-engine';
import {
  consultationDigest,
  expertName,
  renderConsultationSections,
  renderOpinion,
  type ExpertOpinion,
} from '@health-buddy/experts';
import type {
  ConsultationTrigger,
  Synthesis,
  TaskMode,
  TaskStep,
  TaskStreamEvent,
} from '@health-buddy/shared';
import {
  ASK_NOTICE,
  ASK_SYSTEM_PROMPT,
  buildAskUserContent,
  buildSystemPrompt,
  CRISIS_HEADER,
  criticalNotice,
  detectCrisisKeywords,
  finalizeClientText,
  greetClient,
  redactClientIdentity,
  wordingCategories,
  skillUsesReport,
  suggestSkill,
  withAskNotice,
  type SkillDefinition,
} from '@health-buddy/skills';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import type { TenantContext } from '../db/database.js';
import { ConsultationService, type ExpertSteps } from '../experts/consultation.service.js';
import { ExpertsRepository } from '../experts/experts.repository.js';
import { RISK_TIER_CRITERIA } from './risk-tier-criteria.js';
import {
  WorkbenchRepository,
  type ClientContext,
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
   * 回答由后端按意见结构确定性渲染，末尾固定拼接提示；专家全部未能回复时只给固定提示。
   */
  async consultAnswer(
    ctx: TenantContext,
    turn: {
      taskId: string;
      clientId: string | null;
      reportId?: string | null;
      assistantMessageId: string;
      expertId: string | null;
    },
    request: { content: string; expertRefs: string[] },
    io: TurnIo,
  ): Promise<void> {
    const messageId = turn.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    try {
      const client = turn.clientId
        ? await this.readClient(ctx, turn.clientId, steps, turn.reportId ?? null, true)
        : undefined;
      if (turn.clientId && !client)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      const forced = [
        ...new Set([...(turn.expertId ? [turn.expertId] : []), ...request.expertRefs]),
      ];
      const outcome = await this.consultation.consult(
        ctx,
        {
          taskId: turn.taskId,
          messageId,
          clientId: turn.clientId,
          reportId: client?.report?.id ?? null,
          trigger: request.expertRefs.length ? 'mention' : 'expert_center',
          mode: 'direct',
          forced,
          excluded: [],
          bound: turn.expertId,
          source: {
            client: client?.snapshot ?? null,
            question: request.content,
            identifiers: client?.identifiers ?? [],
            earlierTexts: await this.repo.managerTexts(ctx, turn.taskId),
          },
        },
        { emit: io.emit, signal: io.signal, steps: steps.forExperts() },
      );
      if (io.signal.aborted || outcome?.result.status === 'stopped')
        throw new GatewayError('aborted');
      const answered = (outcome?.result.calls ?? []).flatMap((c) =>
        c.status === 'done' && c.opinion
          ? [{ expertId: c.expertId, opinion: c.opinion, removed: c.removedFindings }]
          : [],
      );
      if (!outcome || !answered.length) {
        return await this.finish(ctx, messageId, EXPERTS_UNAVAILABLE, 'complete', io);
      }
      const notices = { crisis: outcome.crisisDetected, emergency: outcome.emergencyDetected };
      let text: string;
      if (answered.length === 1 && outcome.result.calls.length === 1) {
        const only = answered[0]!;
        text = renderOpinion(only.opinion, { ...notices, removedFindings: only.removed });
      } else {
        const sections = renderConsultationSections(
          outcome.result.synthesis,
          answered,
          expertName,
          { synthesisFailed: outcome.result.synthesisStatus === 'failed' },
        );
        const each = answered.map(
          (a) =>
            `### ${expertName(a.expertId)}\n\n${renderOpinion(a.opinion, { ...notices, removedFindings: a.removed })}`,
        );
        text = [sections, ...each].join('\n\n');
      }
      if (!(await io.sessionValid()))
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      io.emit({ type: 'text', messageId, delta: text });
      await this.finish(ctx, messageId, text, 'complete', io);
    } catch (err) {
      await steps.failRunning();
      await this.fail(ctx, messageId, '', err, io);
    }
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

      const step = await steps.start('answer', 'steps.answer');
      const redact = (t: string) => redactClientIdentity(t, client?.identifiers ?? []);
      // 历史消息也去标识：之前几轮里健管师可能提到过姓名或手机号
      const history = (await this.repo.history(ctx, turn.taskId, turn)).map((m) => ({
        ...m,
        content: redact(m.content),
      }));
      const question = redact(request.content);
      const userContent = buildAskUserContent(client?.snapshot, question);

      // 固定的提醒由后端拼在开头，不依赖模型；模型拒答时也保留
      const crisis = detectCrisisKeywords([
        request.content,
        ...(await this.repo.managerTexts(ctx, turn.taskId)),
      ]);
      const notices =
        (crisis ? CRISIS_HEADER : '') +
        (client ? criticalNotice(client.snapshot.criticalFlags) : '');
      push(notices);

      let finishReason: 'complete' | 'truncated' | 'refused' = 'complete';
      for await (const event of this.gateway.stream(
        ctx,
        {
          route: 'chat',
          system: ASK_SYSTEM_PROMPT,
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
      const plan = await this.repo.createPlan(ctx, turn.assistantMessageId, [
        { kind: 'read_client' },
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
    },
    io: TurnIo,
  ): Promise<void> {
    const messageId = run.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    try {
      if (!run.clientId || !run.skills.length)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      const usesReport = run.skills.some(skillUsesReport);
      const client = usesReport
        ? await this.readReport(ctx, run.clientId, steps, run.reportId ?? null, run.skills)
        : await this.readClient(ctx, run.clientId, steps, run.reportId ?? null);
      if (!client) return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');

      // 心理危机信号不只依赖模型判断：健管师的原话、退回原因、本任务之前的消息里有关键词也算
      const crisis = detectCrisisKeywords([
        run.managerRequest,
        run.returnReason ?? '',
        ...(await this.repo.managerTexts(ctx, run.taskId)),
      ]);
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
      const input = {
        client: snapshot,
        managerRequest: redact(run.managerRequest),
        returnReason: run.returnReason === undefined ? undefined : redact(run.returnReason),
        riskTierCriteria: this.riskTierCriteria,
      };

      for (const skill of run.skills) {
        // M3：接入专家的技能（/体检解读）先请专家，预览开关关闭时和 M2 完全一样
        const used =
          skill.experts === 'auto' && this.consultation.preview
            ? await this.skillConsultation(ctx, run, client, steps, io)
            : undefined;
        if (io.signal.aborted) throw new GatewayError('aborted');
        const skillInput = used
          ? { ...input, expertDigest: consultationDigest(used.opinions, expertName) }
          : input;
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
        // 仍没通过就不保存草稿。日志只记类别和次数，不记输出内容
        let issues = result.status === 'ok' ? (skill.checkOutput?.(result.data) ?? []) : [];
        if (issues.length) {
          this.logger.warn(
            `output check failed ${JSON.stringify({ skill: skill.id, attempt: 1, categories: wordingCategories(issues) })}`,
          );
          const note = skill.correctionNote?.(issues) ?? '';
          result = await call(note ? `${userMessage}\n\n${note}` : userMessage);
          issues = result.status === 'ok' ? (skill.checkOutput?.(result.data) ?? []) : [];
          if (issues.length) {
            this.logger.warn(
              `output check failed ${JSON.stringify({ skill: skill.id, attempt: 2, categories: wordingCategories(issues) })}`,
            );
            await steps.finish(step, 'failed');
            const notices =
              (crisis ? CRISIS_HEADER : '') + criticalNotice(client.snapshot.criticalFlags);
            return await this.finish(ctx, messageId, notices, 'error', io, 'wording_check_failed');
          }
        }
        if (result.status === 'refused') {
          // 没有产物，但危机和危急指标提醒要留给健管师
          await steps.finish(step, 'failed');
          const notices =
            (crisis ? CRISIS_HEADER : '') + criticalNotice(client.snapshot.criticalFlags);
          return await this.finish(ctx, messageId, withAskNotice(notices), 'refused', io);
        }
        const output = result.data as Record<string, unknown>;
        if (crisis) output.crisisSignal = true;
        const rendered = skill.render(output, skillInput);
        // 专家意见汇总和分歧由后端确定性写进专业版，绝不进通俗版（M3 规格 2.7）
        const professional = used
          ? `${rendered.professional}\n\n${renderConsultationSections(used.synthesis, used.opinions, expertName, { synthesisFailed: used.synthesisFailed })}`
          : rendered.professional;

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
   * 技能的专家调用（M3 规格 2.5）：退回重写默认复用上一版的专家意见（Q21）；
   * 否则自动路由，“一定要请”“不要请”按健管师的选择。当天专家调用次数用完时不请专家，技能照常生成（Q12）。
   */
  private async skillConsultation(
    ctx: TenantContext,
    run: {
      taskId: string;
      clientId: string | null;
      managerRequest: string;
      assistantMessageId: string;
      reuseConsultationId?: string | null;
      experts?: SkillExpertOptions;
    },
    client: ClientContext,
    steps: StepRunner,
    io: TurnIo,
  ): Promise<UsedConsultation | undefined> {
    if (run.reuseConsultationId) {
      const previous = await this.experts.get(ctx, run.reuseConsultationId);
      if (previous) {
        const opinions = previous.calls.flatMap((c) =>
          c.status === 'done' && c.opinion ? [{ expertId: c.expertId, opinion: c.opinion }] : [],
        );
        const reuse = await steps.start(
          'consult_experts',
          'steps.reuseExperts',
          opinions.map((o) => o.expertId),
        );
        await steps.finish(reuse, 'done');
        return {
          consultationId: previous.id,
          opinions,
          synthesis: previous.synthesis,
          synthesisFailed: previous.synthesisStatus === 'failed',
        };
      }
    }
    const remaining = await this.consultation.remainingToday(ctx);
    if (remaining <= 0) {
      this.logger.warn('expert daily limit reached, skill runs without experts');
      return undefined;
    }
    const options = run.experts ?? { trigger: 'skill_auto' as const, forced: [], excluded: [] };
    const outcome = await this.consultation.consult(
      ctx,
      {
        taskId: run.taskId,
        messageId: run.assistantMessageId,
        clientId: run.clientId,
        reportId: client.report?.id ?? null,
        trigger: options.trigger,
        mode: 'route',
        forced: options.forced,
        excluded: options.excluded,
        source: {
          client: client.snapshot,
          question: run.managerRequest,
          identifiers: client.identifiers,
          earlierTexts: await this.repo.managerTexts(ctx, run.taskId),
        },
        maxExperts: Math.min(remaining, 3),
      },
      { emit: io.emit, signal: io.signal, steps: steps.forExperts() },
    );
    if (!outcome) return undefined;
    if (outcome.result.status === 'stopped') throw new GatewayError('aborted');
    return {
      consultationId: outcome.consultationId,
      opinions: outcome.result.calls.flatMap((c) =>
        c.status === 'done' && c.opinion ? [{ expertId: c.expertId, opinion: c.opinion }] : [],
      ),
      synthesis: outcome.result.synthesis,
      synthesisFailed: outcome.result.synthesisStatus === 'failed',
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

  async start(kind: TaskStep['kind'], labelKey: string, expertIds?: string[]): Promise<TaskStep> {
    const step = await this.repo.startStep(
      this.ctx,
      this.messageId,
      this.seq++,
      kind,
      labelKey,
      null,
      expertIds,
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
