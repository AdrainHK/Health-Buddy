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
  ) {}

  /** 问一问，或想一想、做一做里没有选技能时：直接回答 */
  async answer(
    ctx: TenantContext,
    turn: {
      taskId: string;
      clientId: string | null;
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
      const client = turn.clientId ? await this.readClient(ctx, turn.clientId, steps) : undefined;
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

  /** 想一想：先出计划，等健管师确认（规格 3.3）。M1 的计划只有“读档案”和“调用技能”两步。 */
  async propose(
    ctx: TenantContext,
    turn: { assistantMessageId: string },
    skillId: string,
    io: TurnIo,
  ): Promise<void> {
    try {
      const plan = await this.repo.createPlan(ctx, turn.assistantMessageId, [
        { kind: 'read_client' },
        { kind: 'run_skill', skillId },
      ]);
      io.emit({ type: 'plan', plan });
      await this.finish(ctx, turn.assistantMessageId, '', 'complete', io);
    } catch (err) {
      await this.fail(ctx, turn.assistantMessageId, '', err, io);
    }
  }

  /** 做一做：执行技能，生成草稿（也用于确认计划后执行、退回后重写） */
  async runSkill(
    ctx: TenantContext,
    run: Omit<RegenerationContext, 'skillId'> & { skill: SkillDefinition; returnReason?: string },
    io: TurnIo,
  ): Promise<void> {
    const messageId = run.assistantMessageId;
    const steps = new StepRunner(this.repo, ctx, messageId, io.emit);
    try {
      if (!run.clientId)
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      const client = await this.readClient(ctx, run.clientId, steps);
      if (!client) return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');

      // 心理危机信号不只依赖模型判断：健管师的原话、退回原因、本任务之前的消息里有关键词也算
      const crisis = detectCrisisKeywords([
        run.managerRequest,
        run.returnReason ?? '',
        ...(await this.repo.managerTexts(ctx, run.taskId)),
      ]);
      const step = await steps.start('run_skill', 'steps.runSkill');
      const redact = (t: string) => redactClientIdentity(t, client.identifiers);
      const input = {
        client: client.snapshot,
        managerRequest: redact(run.managerRequest),
        returnReason: run.returnReason === undefined ? undefined : redact(run.returnReason),
      };
      const result = await this.gateway.completeStructured(
        ctx,
        {
          route: 'skill',
          system: buildSystemPrompt(run.skill),
          messages: [{ role: 'user', content: run.skill.buildUserMessage(input) }],
          maxOutputTokens: 8000,
        },
        { name: run.skill.id.replace(/-/g, '_'), schema: run.skill.outputSchema },
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
      const rendered = run.skill.render(output);

      // 保存前重新确认：会话仍然有效、任务没有断开、客户仍归当前健管师
      if (io.signal.aborted) throw new GatewayError('aborted');
      if (!(await io.sessionValid())) {
        await steps.finish(step, 'failed');
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      }
      const artifact = await this.repo.saveArtifact(ctx, run.taskId, run.clientId, {
        skillId: run.skill.id,
        kind: run.skill.kind,
        professional: rendered.professional,
        clientFacing: run.skill.clientFacing
          ? finalizeClientText(greetClient(client.displayName, rendered.clientFacing))
          : '',
        criticalFlags: client.snapshot.criticalFlags,
        parent: run.parent,
      });
      if (!artifact) {
        await steps.finish(step, 'failed');
        return await this.finish(ctx, messageId, '', 'error', io, 'internal_error');
      }
      await steps.finish(step, 'done');
      io.emit({ type: 'artifact', artifact });
      this.logger.log(
        `artifact drafted ${JSON.stringify({
          skill: run.skill.id,
          criticalFlags: client.snapshot.criticalFlags.length,
          urgent: client.snapshot.criticalFlags.filter((f) => f.rule.level === 'urgent').length,
        })}`,
      );
      await this.finish(ctx, messageId, '', 'complete', io);
    } catch (err) {
      await steps.failRunning();
      await this.fail(ctx, messageId, '', err, io);
    }
  }

  /** 读档案、识别危急指标，两步都推给前端 */
  private async readClient(
    ctx: TenantContext,
    clientId: string,
    steps: StepRunner,
  ): Promise<ClientContext | undefined> {
    const read = await steps.start('read_client', 'steps.readClient');
    const client = await this.repo.clientContext(ctx, clientId);
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

  async finish(step: TaskStep, status: 'done' | 'failed'): Promise<void> {
    this.running.delete(step);
    const done = await this.repo.finishStep(this.ctx, step, status);
    this.emit({ type: 'step', step: done });
  }

  async failRunning(): Promise<void> {
    for (const step of [...this.running]) {
      await this.finish(step, 'failed').catch(() => undefined);
    }
  }
}
