/**
 * 专家引擎的编排器（M3 规格 3.1）：路由 → 并行调用 → 每份意见校验（不合格重试一次）→ 汇总。
 *
 * 纯函数式：不读数据库，不读文件。后端用 withTenant 读好去标识化资料传进来，
 * 通过回调写库和推送 SSE。所有大模型调用都经过网关（用途 expert / expert_routing / expert_synthesis）。
 */
import type { SelectedReason, Synthesis, SynthesisStatus } from '@health-buddy/shared';
import { expertOpinionSchema } from '@health-buddy/shared';
import { GatewayError } from '../errors.js';
import type { LlmGateway } from '../gateway.js';
import type { CallContext, ProviderName, Usage } from '../types.js';
import { routeExperts } from './routing.js';
import { callSynthesis, mergeSynthesis, type Responded } from './synthesis.js';
import type {
  ConsultationHooks,
  ConsultationRequest,
  ConsultationResult,
  EngineOptions,
  ExpertCallResult,
  ExpertProfile,
} from './types.js';
import { correctionNote, validateOpinion, type OpinionCheck } from './validate.js';

export const DEFAULT_EXPERT_TIMEOUT_MS = 60_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_EXPERTS = 3;

/** 超时用的中止控制器，能分辨“超时”和“健管师点了停止” */
function timer(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(handle) };
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
}

export async function runConsultation<C extends CallContext>(
  gateway: LlmGateway<C>,
  ctx: C,
  request: ConsultationRequest,
  options: EngineOptions & { signal?: AbortSignal; hooks?: ConsultationHooks } = {},
): Promise<ConsultationResult> {
  const hooks = options.hooks ?? {};
  const stop = options.signal;
  const total = timer(options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  // 回调失败（写库失败、任务不再属于当前健管师）时中止其余调用
  const internal = new AbortController();
  const overall = anySignal([stop, total.signal, internal.signal]);
  try {
    const routing = await routeExperts(gateway, ctx, request, {
      maxExperts: options.maxExperts ?? DEFAULT_MAX_EXPERTS,
      signal: overall,
    });
    await hooks.onRouted?.(routing);

    const profiles = new Map(request.available.map((e) => [e.id, e]));
    const limit = options.limit ?? (<T>(fn: () => Promise<T>) => fn());
    let hookError: unknown;
    const calls = await Promise.all(
      routing.selected.map(async ({ expertId, selectedReason }) => {
        const profile = profiles.get(expertId);
        if (!profile) throw new Error('selected expert is not available');
        try {
          return await limit(async () => {
            if (overall.aborted) return stopped(profile, selectedReason, stop?.aborted ?? false);
            await hooks.onCallStarted?.(expertId, selectedReason);
            const result = await callExpert(gateway, ctx, profile, selectedReason, request, {
              expertTimeoutMs: options.expertTimeoutMs ?? DEFAULT_EXPERT_TIMEOUT_MS,
              overall,
              stop,
              logger: options.logger,
            });
            await hooks.onCallFinished?.(result);
            return result;
          });
        } catch (err) {
          hookError ??= err;
          internal.abort();
          throw err;
        }
      }),
    ).catch((err: unknown) => {
      throw hookError ?? err;
    });

    if (stop?.aborted) {
      return { routing, calls, synthesis: null, synthesisStatus: null, status: 'stopped' };
    }
    const responded: Responded[] = calls.flatMap((c) =>
      c.status === 'done' && c.opinion
        ? [
            {
              expertId: c.expertId,
              name: profiles.get(c.expertId)?.name ?? c.expertId,
              opinion: c.opinion,
            },
          ]
        : [],
    );
    const missingExperts = calls.filter((c) => c.status !== 'done').map((c) => c.expertId);
    const extra = {
      missingExperts,
      crisisDetected: request.input.crisisDetected,
      emergencyDetected: request.input.emergencyDetected,
    };
    if (!calls.length) {
      return { routing, calls, synthesis: null, synthesisStatus: null, status: 'done' };
    }
    if (!responded.length) {
      return { routing, calls, synthesis: null, synthesisStatus: null, status: 'failed' };
    }
    const status = missingExperts.length ? 'partial' : 'done';

    let synthesis: Synthesis;
    let synthesisStatus: SynthesisStatus;
    if (responded.length === 1) {
      // 只有一位专家回复时不调用汇总模型，直接用这份意见（规格 3.5）
      synthesis = mergeSynthesis(responded, null, extra);
      synthesisStatus = 'skipped';
    } else {
      await hooks.onSynthesisStarted?.();
      try {
        const model = await callSynthesis(gateway, ctx, responded, overall);
        synthesis = mergeSynthesis(responded, model, extra);
        synthesisStatus = model ? 'done' : 'failed';
      } catch (err) {
        if (stop?.aborted) {
          return { routing, calls, synthesis: null, synthesisStatus: null, status: 'stopped' };
        }
        if (internal.signal.aborted) throw err;
        // 汇总失败：不显示模型汇总，列出原始意见；转介和危机信号仍由后端合并（规格 3.5）
        options.logger?.warn('expert synthesis failed', { category: errorCategory(err) });
        synthesis = mergeSynthesis(responded, null, extra);
        synthesisStatus = 'failed';
      }
    }
    return { routing, calls, synthesis, synthesisStatus, status };
  } finally {
    total.clear();
  }
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

function stopped(
  profile: ExpertProfile,
  selectedReason: SelectedReason,
  byManager: boolean,
): ExpertCallResult {
  return {
    ...base(profile, selectedReason),
    status: byManager ? 'stopped' : 'timeout',
    failureCategory: byManager ? null : 'timeout',
  };
}

function base(profile: ExpertProfile, selectedReason: SelectedReason) {
  return {
    expertId: profile.id,
    expertVersion: profile.version,
    sourcesVersion: profile.sourcesVersion,
    selectedReason,
    opinion: null,
    removedFindings: 0,
    provider: null as ProviderName | null,
    model: null as string | null,
    usage: emptyUsage(),
  };
}

function errorCategory(err: unknown): string {
  return err instanceof GatewayError ? err.kind : 'internal';
}

/** 调用一位专家：结构 → 引用 → 数值 → 措辞，不合格带着纠正说明重试一次（规格 3.4） */
async function callExpert<C extends CallContext>(
  gateway: LlmGateway<C>,
  ctx: C,
  profile: ExpertProfile,
  selectedReason: SelectedReason,
  request: ConsultationRequest,
  env: {
    expertTimeoutMs: number;
    overall: AbortSignal;
    stop: AbortSignal | undefined;
    logger: EngineOptions['logger'];
  },
): Promise<ExpertCallResult> {
  const own = timer(env.expertTimeoutMs);
  const signal = anySignal([env.overall, own.signal]);
  const result: ExpertCallResult = {
    ...base(profile, selectedReason),
    status: 'failed',
    failureCategory: null,
  };
  const call = async (content: string) => {
    const r = await gateway.completeStructured(
      ctx,
      {
        route: 'expert',
        expertId: profile.id,
        system: profile.systemPrompt,
        messages: [{ role: 'user', content }],
        maxOutputTokens: profile.maxOutputTokens,
      },
      { name: 'expert_opinion', schema: expertOpinionSchema },
      signal,
    );
    result.provider = r.provider;
    result.model = r.model;
    result.usage = {
      inputTokens: result.usage.inputTokens + r.usage.inputTokens,
      outputTokens: result.usage.outputTokens + r.usage.outputTokens,
    };
    return r;
  };
  const check = (opinion: Parameters<typeof validateOpinion>[0]): OpinionCheck =>
    validateOpinion(opinion, profile, request.input.allowedNumbers);
  try {
    const first = await call(request.input.userContent);
    if (first.status === 'refused')
      return { ...result, status: 'refused', failureCategory: 'refused' };
    let checked = check(first.data);
    if (checked.issues.length) {
      env.logger?.warn('expert opinion check failed', {
        expertId: profile.id,
        attempt: 1,
        issues: checked.issues.join(','),
      });
      try {
        const second = await call(
          `${request.input.userContent}\n\n${correctionNote(checked.issues)}`,
        );
        if (second.status === 'ok') {
          const again = check(second.data);
          // 第二次整份不可用而第一次还能用时，用第一次清理后的结果
          if (!again.fatal || checked.fatal) checked = again;
          if (again.issues.length)
            env.logger?.warn('expert opinion check failed', {
              expertId: profile.id,
              attempt: 2,
              issues: again.issues.join(','),
            });
        }
      } catch (err) {
        if (signal.aborted) throw err;
        // 重试出错：退回第一次清理后的结果
      }
    }
    if (checked.fatal || !checked.opinion) {
      return { ...result, status: 'failed', failureCategory: 'invalid_output' };
    }
    return {
      ...result,
      status: 'done',
      failureCategory: null,
      opinion: checked.opinion,
      removedFindings: checked.removed,
    };
  } catch (err) {
    if (env.stop?.aborted) return { ...result, status: 'stopped', failureCategory: null };
    if (signal.aborted || (err instanceof GatewayError && err.kind === 'timeout')) {
      return { ...result, status: 'timeout', failureCategory: 'timeout' };
    }
    if (err instanceof GatewayError && err.kind === 'invalid_output') {
      return { ...result, status: 'failed', failureCategory: 'invalid_output' };
    }
    if (err instanceof GatewayError) {
      return { ...result, status: 'failed', failureCategory: 'provider_error' };
    }
    throw err;
  } finally {
    own.clear();
  }
}
