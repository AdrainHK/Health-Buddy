import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  runConsultation,
  type ConsultationResult,
  type ExpertProfile,
} from '@health-buddy/ai-engine';
import {
  availableExperts,
  buildConsultationInput,
  getExpert,
  isAvailable,
  toProfile,
  type ExpertInputSource,
} from '@health-buddy/experts';
import type { ConsultationTrigger, TaskStep, TaskStreamEvent } from '@health-buddy/shared';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { TenantContext } from '../db/database.js';
import { ExpertsRepository } from './experts.repository.js';

/** 每位健管师每天最多 200 次专家调用（Q12，路由和汇总不计） */
export const DAILY_EXPERT_CALLS = 200;
/** 每位健管师同时进行的专家调用数上限，超过的排队（规格 3.3） */
export const CONCURRENT_EXPERT_CALLS = 6;

/** 执行步骤：由对话生成流程提供，写库并推给前端 */
export interface ExpertSteps {
  start(kind: TaskStep['kind'], labelKey: string, expertIds?: string[]): Promise<TaskStep>;
  finish(step: TaskStep, status: 'done' | 'failed'): Promise<void>;
}

export interface ConsultRun {
  taskId: string;
  /** 挂执行步骤的那条回答 */
  messageId: string;
  clientId: string | null;
  reportId: string | null;
  trigger: ConsultationTrigger;
  /** direct：@专家、专家中心；route：/体检解读 自动选择 */
  mode: 'direct' | 'route';
  forced: string[];
  excluded: string[];
  bound?: string | null;
  source: ExpertInputSource;
  /** 今天剩余的专家调用次数不足 3 时，自动选择最多只请这么多位（Q12） */
  maxExperts?: number;
}

export interface ConsultOutcome {
  consultationId: string;
  result: ConsultationResult;
  crisisDetected: boolean;
  emergencyDetected: boolean;
}

/** 简单的计数信号量：每位健管师一个 */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }
}

/**
 * 专家调用（M3 规格第三节）：后端用 withTenant 读好去标识化资料，交给 packages/ai-engine 的专家引擎；
 * 引擎通过回调报告进度，这里写库和推送 SSE。日志只记 id、专家 id、状态、类别和数量（规格 6.1）。
 */
@Injectable()
export class ConsultationService {
  private readonly logger = new Logger('Experts');
  private readonly limits = new Map<string, Semaphore>();

  constructor(
    private readonly repo: ExpertsRepository,
    @Inject(LLM_GATEWAY) private readonly gateway: AppGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get preview(): boolean {
    return this.config.expertsPreview;
  }

  /** 当前账号可用的专家 id（预览开关 + 平台暂停） */
  async availableIds(ctx: TenantContext): Promise<Set<string>> {
    const paused = await this.repo.pausedExperts(ctx);
    return new Set(availableExperts({ preview: this.preview, paused }).map((e) => e.meta.id));
  }

  /** 这些专家都可用；有一位不可用就按“不存在”处理（规格 2.4） */
  async allAvailable(ctx: TenantContext, ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return true;
    const paused = await this.repo.pausedExperts(ctx);
    return ids.every((id) => {
      const def = getExpert(id);
      return def ? isAvailable(def, { preview: this.preview, paused }) : false;
    });
  }

  /** 今天还能调用几位专家（Q12） */
  async remainingToday(ctx: TenantContext): Promise<number> {
    return Math.max(0, DAILY_EXPERT_CALLS - (await this.repo.callsToday(ctx)));
  }

  private limit(managerId: string) {
    let s = this.limits.get(managerId);
    if (!s) {
      s = new Semaphore(CONCURRENT_EXPERT_CALLS);
      this.limits.set(managerId, s);
    }
    const sem = s;
    return <T>(fn: () => Promise<T>) =>
      sem.run(fn).finally(() => {
        if (sem.idle) this.limits.delete(managerId);
      });
  }

  async consult(
    ctx: TenantContext,
    run: ConsultRun,
    io: { emit: (event: TaskStreamEvent) => void; signal: AbortSignal; steps: ExpertSteps },
  ): Promise<ConsultOutcome | undefined> {
    const paused = await this.repo.pausedExperts(ctx);
    const available: ExpertProfile[] = availableExperts({ preview: this.preview, paused }).map(
      (e) => toProfile(e, { preview: this.preview }),
    );
    if (!available.length) return undefined;
    const input = buildConsultationInput(run.source);
    // 信号随调用进展只增不减：关键词 → 每位专家（意见没通过校验也算）→ 汇总（合规审查第 1 条）
    const signals = { crisis: input.crisisDetected, emergency: input.emergencyDetected };

    let consultationId: string | undefined;
    const callIds = new Map<string, string>();
    let routeStep: TaskStep | undefined;
    let consultStep: TaskStep | undefined;
    let synthStep: TaskStep | undefined;
    // 已经结束的步骤：出错时只把还在进行的步骤标为失败，已完成的不改回失败
    const finished = new Set<TaskStep>();
    const finishStep = async (step: TaskStep, status: 'done' | 'failed') => {
      finished.add(step);
      await io.steps.finish(step, status);
    };
    if (run.mode === 'route')
      routeStep = await io.steps.start('route_experts', 'steps.routeExperts');
    try {
      const result = await runConsultation(
        this.gateway,
        ctx,
        {
          input,
          available,
          mode: run.mode,
          forced: run.forced,
          excluded: run.excluded,
          bound: run.bound ?? null,
        },
        {
          signal: io.signal,
          limit: this.limit(ctx.userId),
          ...(run.maxExperts !== undefined ? { maxExperts: run.maxExperts } : {}),
          logger: {
            warn: (message, fields) => this.logger.warn(`${message} ${JSON.stringify(fields)}`),
          },
          hooks: {
            onRouted: async (routing) => {
              if (routeStep) await finishStep(routeStep, 'done');
              // 调用记录和配额在同一个事务里占好（并发请求不会一起越过每日上限）
              const planned = routing.selected.flatMap((s) => {
                const profile = available.find((p) => p.id === s.expertId);
                return profile
                  ? [
                      {
                        expertId: profile.id,
                        version: profile.version,
                        sourcesVersion: profile.sourcesVersion,
                        selectedReason: s.selectedReason,
                      },
                    ]
                  : [];
              });
              // 超过每日上限时抛 ExpertQuotaExceeded：技能照常生成，@专家 提示稍后再试
              const created = await this.repo.createConsultation(
                ctx,
                {
                  taskId: run.taskId,
                  messageId: run.messageId,
                  clientId: run.clientId,
                  reportId: run.reportId,
                  trigger: run.trigger,
                  routing,
                  signals: { ...signals },
                },
                planned,
                DAILY_EXPERT_CALLS,
              );
              consultationId = created.consultationId;
              for (const [id, callId] of created.callIds) callIds.set(id, callId);
              const ids = routing.selected.map((s) => s.expertId);
              if (ids.length) {
                consultStep = await io.steps.start(
                  ids.length === 1 ? 'consult_expert' : 'consult_experts',
                  ids.length === 1 ? 'steps.consultExpert' : 'steps.consultExperts',
                  ids,
                );
              }
            },
            onCallStarted: (expertId) => {
              if (!consultationId || !callIds.has(expertId)) return;
              io.emit({
                type: 'expert_call',
                consultationId,
                expertId,
                status: 'running',
                failureCategory: null,
              });
            },
            onCallFinished: async (r) => {
              signals.crisis ||= r.crisisSignal;
              signals.emergency ||= r.emergencySignal;
              const callId = callIds.get(r.expertId);
              if (!consultationId) return;
              if (callId) await this.repo.finishCall(ctx, callId, r);
              io.emit({
                type: 'expert_call',
                consultationId,
                expertId: r.expertId,
                status: r.status,
                failureCategory: r.failureCategory,
              });
            },
            onSynthesisStarted: async () => {
              synthStep = await io.steps.start('synthesize_experts', 'steps.synthesizeExperts');
            },
          },
        },
      );
      if (!consultationId) return undefined;
      const anyAnswered = result.calls.some((c) => c.status === 'done');
      if (consultStep) await finishStep(consultStep, anyAnswered ? 'done' : 'failed');
      if (synthStep)
        await finishStep(synthStep, result.synthesisStatus === 'done' ? 'done' : 'failed');
      const final = result.status;
      signals.crisis ||=
        result.calls.some((c) => c.crisisSignal) || !!result.synthesis?.crisisSignal;
      signals.emergency ||=
        result.calls.some((c) => c.emergencySignal) || !!result.synthesis?.emergencySignal;
      await this.repo.finishConsultation(
        ctx,
        consultationId,
        final,
        final === 'stopped' ? null : result.synthesis,
        final === 'stopped' ? null : result.synthesisStatus,
        signals,
      );
      io.emit({
        type: 'consultation',
        consultationId,
        status: final,
        crisisSignal: signals.crisis,
        emergencySignal: signals.emergency,
      });
      this.logger.log(
        `consultation finished ${JSON.stringify({
          trigger: run.trigger,
          status: final,
          experts: result.calls.length,
          answered: result.calls.filter((c) => c.status === 'done').length,
          removed: result.calls.reduce((n, c) => n + c.removedFindings, 0),
          synthesis: result.synthesisStatus,
          ruleOnly: result.routing.ruleOnly,
        })}`,
      );
      return {
        consultationId,
        result,
        // 关键词，或任何一位专家标出的信号（意见没通过校验时也算，合规审查第 2 条）
        crisisDetected: signals.crisis,
        emergencyDetected: signals.emergency,
      };
    } catch (err) {
      for (const step of [routeStep, consultStep, synthStep]) {
        if (step && !finished.has(step)) await finishStep(step, 'failed').catch(() => undefined);
      }
      if (consultationId) {
        await this.repo.stopRunning(ctx, consultationId, signals);
        io.emit({
          type: 'consultation',
          consultationId,
          status: 'stopped',
          crisisSignal: signals.crisis,
          emergencySignal: signals.emergency,
        });
      }
      throw err;
    }
  }
}
