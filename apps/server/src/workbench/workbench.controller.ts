import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { getExpert } from '@health-buddy/experts';
import {
  EXPERTS_PER_CALL_MAX,
  TWIN_CONSULT_DEFAULT_REQUEST,
  addExpertRequestSchema,
  reconsultRequestSchema,
  returnArtifactRequestSchema,
  sendMessageRequestSchema,
  type ExpertConsultation,
  type TaskStreamEvent,
} from '@health-buddy/shared';
import {
  PLAN_TEMPLATES,
  getPlanTemplate,
  getSkill,
  skillUsesReport,
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
import { ConsultationService } from '../experts/consultation.service.js';
import { ExpertsRepository } from '../experts/experts.repository.js';
import { GenerationService, type SkillExpertOptions, type TurnIo } from './generation.service.js';
import { GenerationRegistry } from './generation-registry.js';
import { LLM_RATE_LIMITER, type LlmRateLimiter } from './llm-rate-limiter.js';
import { WorkbenchRepository, type RegenerationContext } from './workbench.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/** 直接请专家的调用（@专家、专家中心、补请）：重新请时同样直接请，不经过自动选择 */
function isDirect(c: ExpertConsultation): boolean {
  return (
    c.origin?.kind === 'add_expert' || c.trigger === 'mention' || c.trigger === 'expert_center'
  );
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
    private readonly consultation: ConsultationService,
    private readonly experts: ExpertsRepository,
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
    // “请专家看看”（M4 规格 2.6 之二）：专家预览关闭时没有这个入口，按不存在处理；
    // 健管师补充了问题文字时才用模型补充路由
    const typed = input.content.trim().length > 0;
    if (input.twinConsult) {
      if (!this.consultation.preview) throw notFound();
      if (!input.content) input.content = TWIN_CONSULT_DEFAULT_REQUEST;
    }
    // 输入框为空：只有不需要再写要求的技能可以，用技能的默认要求（验收反馈 8）
    if (!input.content) {
      const fallback = (plan ?? skill)?.defaultRequest ?? null;
      if (fallback === null) throw badRequest();
      input.content = fallback;
    }
    // 引用的归属先核对（只读）：别人的任务、客户、孪生项、跟进项返回 404，不会因为次数用完返回 429
    await this.repo.checkTurnRefs(session, {
      taskId,
      clientRefs: input.clientRefs,
      reportRefs: input.reportRefs,
      twinRefs: input.twinRefs,
      ...(input.followUpItemId ? { followUpItemId: input.followUpItemId } : {}),
    });
    const direct = await this.checkExperts(session, taskId, input, skill, plan);
    // “请专家看看”超出当天的专家调用次数时返回 429
    if (input.twinConsult && (await this.consultation.remainingToday(session)) <= 0) {
      throw tooManyRequests();
    }
    const usesTwin = Boolean(skill?.usesTwin || plan?.skills.some((id) => getSkill(id)?.usesTwin));
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
          usesReport: plan ? true : skill ? skillUsesReport(skill) : false,
          expertRefs: input.expertRefs,
          excludedExperts: input.excludedExperts,
          twinRefs: input.twinRefs,
          ...(input.followUpItemId ? { followUpItemId: input.followUpItemId } : {}),
          requiresTwinData: usesTwin,
        },
        claim,
      ),
    );
    await this.stream(turn, req, res, session, (io) => {
      if (plan) return this.generation.propose(session, turn.value, plan.skills, io);
      if (input.twinConsult)
        return this.generation.twinConsultAnswer(
          session,
          turn.value,
          {
            content: input.content,
            expertRefs: input.expertRefs,
            excludedExperts: input.excludedExperts,
            typed,
          },
          io,
        );
      if (direct)
        return this.generation.consultAnswer(
          session,
          turn.value,
          { content: input.content, expertRefs: input.expertRefs },
          io,
        );
      if (!skill) return this.generation.answer(session, turn.value, input, io);
      if (input.mode === 'plan')
        return this.generation.propose(session, turn.value, [skill.id], io);
      return this.generation.runSkill(
        session,
        {
          ...turn.value,
          skills: [skill],
          managerRequest: input.content,
          requestMessageId: turn.value.managerMessageId,
          parent: undefined,
          experts: {
            trigger: 'skill_auto',
            forced: input.expertRefs,
            excluded: input.excludedExperts,
          },
        },
        io,
      );
    });
  }

  /**
   * 专家相关的校验（M3 规格 2.3、2.4、3.7），都在占用任务和写库之前：
   * - 只有接入专家的技能（experts: auto）和问一问可以 @专家；“不要请”只对技能有效；多步计划不接入，返回 400；
   * - @ 的专家对当前账号不可用（预览关闭、平台暂停、不存在）按“不存在”处理，返回 404；
   * - 专家中心的任务固定为问一问；
   * - 直接请专家（问一问）超出当天的专家调用次数时返回 429。
   * 返回这条消息是否直接请专家回答。
   */
  private async checkExperts(
    session: ResolvedSession,
    taskId: string,
    input: {
      mode: string;
      expertRefs: string[];
      excludedExperts: string[];
      twinConsult?: boolean;
    },
    skill: SkillDefinition | undefined,
    plan: PlanTemplate | undefined,
  ): Promise<boolean> {
    const { expertRefs, excludedExperts } = input;
    if (expertRefs.length || excludedExperts.length) {
      if (plan) throw badRequest();
      if (skill && skill.experts !== 'auto') throw badRequest();
      // “不要请”只对自动选择有效：技能和“请专家看看”
      if (!skill && !input.twinConsult && excludedExperts.length) throw badRequest();
      if (!this.consultation.preview) throw expertRefs.length ? notFound() : badRequest();
      if (!(await this.consultation.allAvailable(session, expertRefs))) throw notFound();
      if (excludedExperts.some((id) => !getExpert(id))) throw notFound();
    }
    const bound = await this.repo.taskExpert(session, taskId);
    if (bound === undefined) throw notFound();
    if (bound) {
      if (input.mode !== 'ask' || skill || plan || input.twinConsult) throw badRequest();
      if (!(await this.consultation.allAvailable(session, [bound]))) throw notFound();
    }
    const direct =
      input.mode === 'ask' &&
      !skill &&
      !plan &&
      !input.twinConsult &&
      (expertRefs.length > 0 || !!bound);
    if (direct) {
      const count = new Set([...expertRefs, ...(bound ? [bound] : [])]).size;
      if ((await this.consultation.remainingToday(session)) < count) throw tooManyRequests();
    }
    return direct;
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
      this.repo.confirmPlan(
        session,
        taskId,
        plan,
        claim,
        (id) => {
          const skill = getSkill(id);
          if (skill?.requiresReport) return 'required';
          return skill && skillUsesReport(skill) ? 'optional' : 'none';
        },
        (id) => Boolean(getSkill(id)?.usesTwin),
      ),
    );
    await this.regenerate(run, req, res, session, undefined, {
      trigger: 'plan',
      forced: run.value.expertRefs ?? [],
      excluded: run.value.excludedExperts ?? [],
    });
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
    const reconsult = parsed.data.reconsult === true;
    if (reconsult) {
      // 重新请专家（Q21）：专家预览关闭时没有专家可请；当天的专家调用次数用完时返回 429（规格 6.4）
      if (!this.consultation.preview) throw badRequest();
      if ((await this.consultation.remainingToday(session)) <= 0) throw tooManyRequests();
    }
    this.acquire(session);
    const run = await this.claim(session, (claim) =>
      this.repo.returnArtifact(session, artifactId, parsed.data.reason, claim, (skillId) => [
        skillId,
        ...PLAN_TEMPLATES.filter((p) => p.skills.includes(skillId)).map((p) => p.id),
      ]),
    );
    await this.regenerate(run, req, res, session, parsed.data.reason, undefined, reconsult);
  }

  /**
   * 重新请专家（M3 规格 6.4、Q21）：按原调用的问题和报告再请一次，可以调整“一定要请”和“不要请”，
   * 生成新的调用记录，计入每日用量。直接请专家（@专家、专家中心、补请）的调用重新直接请；
   * /体检解读 自动调用的重新自动选择。回答写在对话里的一条新回答，产物不变（重写产物用退回重写）。
   * 别人的调用 404；只读任务 409；当天次数不够 429。
   */
  @Post('expert-consultations/:id/reconsult')
  @HttpCode(200)
  async reconsult(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const original = await this.followUpTarget(session, id);
    const parsed = reconsultRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw badRequest();
    const direct = isDirect(original);
    const routing = original.routing;
    const bound = direct ? await this.repo.taskExpert(session, original.taskId) : null;
    if (bound === undefined) throw notFound();
    // 不传时沿用原来的选择：直接请的是原来请的专家，自动选择的是健管师当时指定的专家和排除的专家
    const previousForced = routing.selected
      .filter((s) => (direct ? true : s.reasons.some((r) => r.kind === 'manager')))
      .map((s) => s.expertId)
      .filter((id) => id !== bound);
    const forced = [
      ...new Set([...(bound ? [bound] : []), ...(parsed.data.forced ?? previousForced)]),
    ];
    const excluded = parsed.data.excluded ?? (direct ? [] : routing.excluded);
    if (direct && (excluded.length > 0 || forced.length === 0)) throw badRequest();
    if (forced.length > EXPERTS_PER_CALL_MAX) throw badRequest();
    if (forced.some((e) => excluded.includes(e))) throw badRequest();
    if (!(await this.consultation.allAvailable(session, forced))) throw notFound();
    if (excluded.some((e) => !getExpert(e))) throw notFound();
    const remaining = await this.consultation.remainingToday(session);
    if (direct ? remaining < forced.length : remaining <= 0) throw tooManyRequests();
    this.acquire(session);
    // 带孪生项的调用（“请专家看看”，或问一问里同时 @专家 和 @孪生项）重新请时沿用原来的孪生项；
    // “请专家看看”依据的是孪生，不要求报告，只按规则路由
    const twinData = original.twinRefs.length > 0;
    const twin = original.trigger === 'twin' && twinData;
    const turn = await this.claim(session, (claim) =>
      this.repo.prepareFollowUp(session, original.id, claim, {
        requiresReport: !direct && !twin,
      }),
    );
    await this.stream(turn, req, res, session, (io) =>
      this.generation.followUpAnswer(
        session,
        turn.value,
        {
          trigger: original.trigger,
          mode: direct ? 'direct' : 'route',
          forced,
          excluded,
          bound,
          origin: { kind: 'reconsult', consultationId: original.id },
          ...(direct ? {} : { maxExperts: Math.min(remaining, EXPERTS_PER_CALL_MAX) }),
          ...(twinData
            ? { twinRefs: original.twinRefs, ...(twin ? { modelRouting: false } : {}) }
            : {}),
        },
        io,
      ),
    );
  }

  /**
   * 补请因数量上限没请的专家（M3 规格 2.6、3.2 第 4 条）：只能补请原调用里“因数量上限未调用”的专家，
   * 生成只有这一位专家的新调用记录，不受每次 3 位的上限约束，但计入每日用量。
   * 别人的调用 404；只读任务 409；当天次数用完 429。
   */
  @Post('expert-consultations/:id/add-expert')
  @HttpCode(200)
  async addExpert(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const original = await this.followUpTarget(session, id);
    const parsed = addExpertRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const { expertId } = parsed.data;
    if (!original.routing.overCap.includes(expertId)) throw badRequest();
    if (!(await this.consultation.allAvailable(session, [expertId]))) throw notFound();
    if ((await this.consultation.remainingToday(session)) < 1) throw tooManyRequests();
    this.acquire(session);
    const turn = await this.claim(session, (claim) =>
      this.repo.prepareFollowUp(session, original.id, claim, { requiresReport: false }),
    );
    await this.stream(turn, req, res, session, (io) =>
      this.generation.followUpAnswer(
        session,
        turn.value,
        {
          trigger: original.trigger,
          mode: 'direct',
          forced: [expertId],
          excluded: [],
          bound: null,
          origin: { kind: 'add_expert', consultationId: original.id },
          maxExperts: 1,
          // 补请带孪生项的调用里的专家：同样给孪生资料
          ...(original.twinRefs.length ? { twinRefs: original.twinRefs } : {}),
        },
        io,
      ),
    );
  }

  /** 重新请、补请的那次调用：必须属于当前健管师（行级安全），专家预览关闭时按不存在处理 */
  private async followUpTarget(session: ResolvedSession, id: string): Promise<ExpertConsultation> {
    const consultationId = parseId(id);
    if (!this.consultation.preview) throw notFound();
    const original = await this.experts.get(session, consultationId);
    if (!original) throw notFound();
    return original;
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
    experts?: SkillExpertOptions,
    reconsult = false,
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
          ...(experts ? { experts } : {}),
          ...(reconsult ? { reconsult } : {}),
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
