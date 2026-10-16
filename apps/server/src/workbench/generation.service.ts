import { Inject, Injectable, Logger } from '@nestjs/common';
import { GatewayError } from '@health-buddy/ai-engine';
import type { TaskMode, TaskStep, TaskStreamEvent } from '@health-buddy/shared';
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
  suggestSkill,
  withAskNotice,
  type SkillDefinition,
} from '@health-buddy/skills';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import type { TenantContext } from '../db/database.js';
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
  | 'internal_error';

/** 流式回答期间多久把已生成的文本存一次库，刷新页面也能看到 */
const FLUSH_MS = 2000;

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
  ) {}

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
    },
    io: TurnIo,
  ): Promise<void> {
    const messageId = run.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    try {
      if (!run.clientId || !run.skills.length)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      const usesReport = run.skills.some((s) => s.requiresReport);
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
        const step = await steps.start('run_skill', skill.runStepLabel ?? 'steps.runSkill');
        const result = await this.gateway.completeStructured(
          ctx,
          {
            // 规格 4.1：/体检解读 用已登记的 report_interpretation 用途，其他技能用 skill 用途
            route: skill.route ?? 'skill',
            system: buildSystemPrompt(skill),
            messages: [{ role: 'user', content: skill.buildUserMessage(input) }],
            maxOutputTokens: 8000,
          },
          { name: skill.id.replace(/-/g, '_'), schema: skill.outputSchema },
          io.signal,
        );
        if (result.status === 'refused') {
          // 没有产物，但危机和危急指标提醒要留给健管师
          await steps.finish(step, 'failed');
          const notices =
            (crisis ? CRISIS_HEADER : '') + criticalNotice(client.snapshot.criticalFlags);
          return await this.finish(ctx, messageId, withAskNotice(notices), 'refused', io);
        }
        const output = result.data as Record<string, unknown>;
        if (crisis) output.crisisSignal = true;
        const rendered = skill.render(output, input);

        // 保存前重新确认：会话仍然有效、任务没有断开、客户仍归当前健管师
        if (io.signal.aborted) throw new GatewayError('aborted');
        if (!(await io.sessionValid())) {
          await steps.finish(step, 'failed');
          return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
        }
        const artifact = await this.repo.saveArtifact(ctx, run.taskId, run.clientId, {
          skillId: skill.id,
          kind: skill.kind,
          professional: rendered.professional,
          clientFacing: skill.clientFacing
            ? finalizeClientText(greetClient(client.displayName, rendered.clientFacing))
            : '',
          criticalFlags: client.snapshot.criticalFlags,
          // 多步计划里只有第一步是“基于这一版修改”，其余都是新的产物
          parent: run.skills.length === 1 ? run.parent : undefined,
          sourceReportId: skill.requiresReport ? (client.report?.id ?? null) : null,
          riskTierSuggestion: rendered.riskTierSuggestion ?? null,
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
   * 用报告的技能读资料（规格 2.5 第 4 条）：正在读取报告（日期）→ 正在对比历次报告
   * →（/体检解读）正在识别危急指标。报告不见了（并发转出等）时失败，不退回到别的报告。
   */
  private async readReport(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
    reportId: string | null,
    skills: SkillDefinition[],
  ): Promise<ClientContext | undefined> {
    const read = await steps.start('read_report', 'steps.readReport');
    const client = await this.repo.clientContext(ctx, clientId, reportId, { detail: true });
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
  ): Promise<ClientContext | undefined> {
    const read = await steps.start('read_client', 'steps.readClient');
    const client = await this.repo.clientContext(ctx, clientId, reportId);
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

  async start(kind: TaskStep['kind'], labelKey: string): Promise<TaskStep> {
    const step = await this.repo.startStep(this.ctx, this.messageId, this.seq++, kind, labelKey);
    this.running.add(step);
    this.emit({ type: 'step', step });
    return step;
  }

  async finish(step: TaskStep, status: 'done' | 'failed', labelDate?: string): Promise<void> {
    this.running.delete(step);
    const done = await this.repo.finishStep(this.ctx, step, status, labelDate);
    this.emit({ type: 'step', step: done });
  }

  async failRunning(): Promise<void> {
    for (const step of [...this.running]) {
      await this.finish(step, 'failed').catch(() => undefined);
    }
  }
}
