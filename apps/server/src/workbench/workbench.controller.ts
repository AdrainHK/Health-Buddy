import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  returnArtifactRequestSchema,
  sendMessageRequestSchema,
  type TaskStreamEvent,
} from '@health-buddy/shared';
import {
  PLAN_TEMPLATES,
  getPlanTemplate,
  getSkill,
  type PlanTemplate,
  type SkillDefinition,
} from '@health-buddy/skills';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { SESSION_COOKIE, SessionService } from '../auth/session.service.js';
import { badRequest, notFound, tooManyRequests } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { GenerationService, type TurnIo } from './generation.service.js';
import { GenerationRegistry } from './generation-registry.js';
import { LLM_RATE_LIMITER, type LlmRateLimiter } from './llm-rate-limiter.js';
import { WorkbenchRepository, type RegenerationContext } from './workbench.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

interface Claimed<T> {
  value: T;
  taskId: string;
  abort: AbortController;
}

/**
 * 对话和生成接口（M1 规格 3.2、3.3、第六节）。
 *
 * 先校验角色、请求体、限流和归属，不通过直接返回 JSON 错误；
 * 通过后才打开 SSE 推送生成过程。SSE 的 error 事件只带错误类别，不带厂商原始信息。
 */
@Controller()
export class WorkbenchController {
  constructor(
    private readonly repo: WorkbenchRepository,
    private readonly generation: GenerationService,
    private readonly registry: GenerationRegistry,
    private readonly sessions: SessionService,
    @Inject(LLM_RATE_LIMITER) private readonly limiter: LlmRateLimiter,
  ) {}

  @Post('tasks/:id/messages')
  @HttpCode(200)
  async send(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const taskId = parseId(id);
    const parsed = sendMessageRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const input = parsed.data;
    let skill: SkillDefinition | undefined;
    let plan: PlanTemplate | undefined;
    if (input.skillId !== undefined) {
      skill = getSkill(input.skillId);
      // 多步计划（Q22）只能在想一想模式下用
      plan = skill ? undefined : getPlanTemplate(input.skillId);
      if (plan && input.mode !== 'plan') throw badRequest();
      // 问一问带技能已被契约拦截；技能还必须支持当前模式
      if (!plan && (!skill || !(skill.modes as string[]).includes(input.mode))) throw badRequest();
    }
    this.acquire(session);

    const turn = await this.claim(session, (claim) =>
      this.repo.prepareTurn(
        session,
        {
          taskId,
          mode: input.mode,
          content: input.content,
          skillId: input.skillId,
          clientRefs: input.clientRefs,
          reportRefs: input.reportRefs,
          requiresClient: (plan ?? skill)?.requiresClient ?? false,
          requiresReport: plan?.requiresReport ?? skill?.requiresReport ?? false,
        },
        claim,
      ),
    );
    await this.stream(turn, req, res, session, (io) => {
      if (plan) return this.generation.propose(session, turn.value, plan.skills, io);
      if (!skill) return this.generation.answer(session, turn.value, input, io);
      if (input.mode === 'plan')
        return this.generation.propose(session, turn.value, [skill.id], io);
      return this.generation.runSkill(
        session,
        { ...turn.value, skills: [skill], managerRequest: input.content, parent: undefined },
        io,
      );
    });
  }

  @Post('tasks/:id/plans/:planId/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('planId') planId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const taskId = parseId(id);
    const plan = parseId(planId);
    this.acquire(session);
    const run = await this.claim(session, (claim) =>
      this.repo.confirmPlan(session, taskId, plan, claim, (id) =>
        Boolean(getSkill(id)?.requiresReport),
      ),
    );
    await this.regenerate(run, req, res, session);
  }

  /** 退回重写：产物改为已退回，AI 按退回原因生成新版本（规格 3.6） */
  @Post('artifacts/:id/return')
  @HttpCode(200)
  async returnArtifact(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const artifactId = parseId(id);
    const parsed = returnArtifactRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    this.acquire(session);
    const run = await this.claim(session, (claim) =>
      this.repo.returnArtifact(session, artifactId, parsed.data.reason, claim, (skillId) => [
        skillId,
        ...PLAN_TEMPLATES.filter((p) => p.skills.includes(skillId)).map((p) => p.id),
      ]),
    );
    await this.regenerate(run, req, res, session, parsed.data.reason);
  }

  /** 停止当前生成。任务不属于当前健管师时 404，也不会影响别人的生成。 */
  @Post('tasks/:id/stop')
  @HttpCode(200)
  async stop(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<{ stopped: boolean }> {
    requireManager(session);
    const taskId = parseId(id);
    if (!(await this.repo.taskVisible(session, taskId))) throw notFound();
    return { stopped: this.registry.stop(taskId, session.userId) };
  }

  private async regenerate(
    run: Claimed<RegenerationContext>,
    req: Request,
    res: Response,
    session: ResolvedSession,
    returnReason?: string,
  ): Promise<void> {
    const skills = run.value.skillIds.map((id) => getSkill(id));
    await this.stream(run, req, res, session, async (io) => {
      if (!skills.length || skills.some((s) => !s)) {
        io.emit({ type: 'error', kind: 'internal_error' });
        io.emit({ type: 'done', messageId: run.value.assistantMessageId, reason: 'error' });
        return;
      }
      await this.generation.runSkill(
        session,
        {
          ...run.value,
          skills: skills as SkillDefinition[],
          ...(returnReason !== undefined ? { returnReason } : {}),
        },
        io,
      );
    });
  }

  private acquire(session: ResolvedSession): void {
    if (!this.limiter.tryAcquire(session.userId)) throw tooManyRequests();
  }

  /**
   * 仓储在事务里校验完归属后调用 claim，占住这个任务的生成（同一任务不并行）。
   * 事务后续失败时释放，不留下占位。
   */
  private async claim<T>(
    session: ResolvedSession,
    fn: (claim: (taskId: string) => boolean) => Promise<T>,
  ): Promise<Claimed<T>> {
    let claimed: { taskId: string; abort: AbortController } | undefined;
    try {
      const value = await fn((taskId) => {
        const abort = this.registry.start(taskId, session.userId);
        if (abort) claimed = { taskId, abort };
        return Boolean(abort);
      });
      if (!claimed) throw new Error('generation was not claimed');
      return { value, ...claimed };
    } catch (err) {
      if (claimed) this.registry.finish(claimed.taskId, claimed.abort);
      throw err;
    }
  }

  /** 打开 SSE 并执行生成。客户端断开等同于停止。 */
  private async stream(
    claimed: Claimed<unknown>,
    req: Request,
    res: Response,
    session: ResolvedSession,
    run: (io: TurnIo) => Promise<void>,
  ): Promise<void> {
    const { abort, taskId } = claimed;
    res.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const io: TurnIo = {
      emit: (event: TaskStreamEvent) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      signal: abort.signal,
      sessionValid: async () => {
        if (typeof token !== 'string') return false;
        const current = await this.sessions.resolve(token);
        // 机构或协会变了（调岗）也算失效：本轮用的是请求开始时的租户上下文
        return (
          current?.userId === session.userId &&
          current.role === 'manager' &&
          current.orgId === session.orgId &&
          current.operatorId === session.operatorId
        );
      },
    };
    try {
      await run(io);
    } finally {
      this.registry.finish(taskId, abort);
      res.end();
    }
  }
}
