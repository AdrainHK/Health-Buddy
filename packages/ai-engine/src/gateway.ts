import { z } from 'zod';
import { resolveRoute, type GatewayConfig } from './config.js';
import { classifyError, GatewayError } from './errors.js';
import { estimateCostUsd } from './pricing.js';
import type {
  CallContext,
  FinishReason,
  GatewayEvent,
  GatewayLogger,
  GatewayRequest,
  Provider,
  ProviderName,
  Usage,
  UsageRecord,
} from './types.js';

export interface GatewayOptions<C extends CallContext = CallContext> {
  config: GatewayConfig;
  providers: Partial<Record<ProviderName, Provider>>;
  /**
   * 每次调用结束（成功、拒答、出错）都会调用一次，用于计量入库。
   * ctx 是调用方传入的上下文原样转交，方便调用方按自己的租户上下文写库。
   */
  recordUsage?: (record: UsageRecord, ctx: C) => Promise<void> | void;
  logger?: GatewayLogger;
  now?: () => number;
}

const STRUCTURED_ATTEMPTS = 2;

/** usage 是所有尝试（含结构不合格重试）的合计，provider 是这次实际用的厂商 */
export type StructuredResult<T> =
  | { status: 'ok'; data: T; model: string; provider: ProviderName; usage: Usage }
  | { status: 'refused'; model: string; provider: ProviderName; usage: Usage };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface CompleteResult {
  text: string;
  finishReason: FinishReason;
  usage: Usage;
  model: string;
  provider: ProviderName;
}

/**
 * 大模型网关：所有大模型调用的唯一入口。
 *
 * 日志和计量只记录用途、厂商、型号、耗时、token 数和错误类型，
 * 从不记录提示词和回答原文（红线 2）。
 */
export class LlmGateway<C extends CallContext = CallContext> {
  private readonly now: () => number;

  constructor(private readonly options: GatewayOptions<C>) {
    this.now = options.now ?? Date.now;
  }

  async *stream(
    ctx: C,
    request: GatewayRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<GatewayEvent, void, undefined> {
    const route = resolveRoute(this.options.config, request.route);
    const provider = this.options.providers[route.provider];
    const started = this.now();
    const base = {
      route: request.route,
      provider: route.provider,
      operatorId: ctx.operatorId,
      userId: ctx.userId,
      ...(request.expertId ? { expertId: request.expertId } : {}),
    };

    let finished = false;
    const finish = async (
      outcome: UsageRecord['outcome'],
      model: string,
      usage: Usage,
      errorType?: string,
      detail?: { status?: number | undefined; code?: string | undefined },
    ) => {
      finished = true;
      const record: UsageRecord = {
        ...base,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: estimateCostUsd(model, usage.inputTokens, usage.outputTokens),
        durationMs: this.now() - started,
        outcome,
        ...(errorType ? { errorType } : {}),
      };
      const fields = {
        route: record.route,
        provider: record.provider,
        model: record.model,
        outcome: record.outcome,
        durationMs: record.durationMs,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        errorType: record.errorType ?? null,
        ...(record.expertId ? { expertId: record.expertId } : {}),
        ...(detail?.status ? { status: detail.status } : {}),
        ...(detail?.code ? { code: detail.code } : {}),
      };
      if (outcome === 'error') this.options.logger?.error('llm call failed', fields);
      else this.options.logger?.info('llm call', fields);
      try {
        await this.options.recordUsage?.(record, ctx);
      } catch {
        // 计量失败不影响业务，只记一条不含数据的日志
        this.options.logger?.error('llm usage record failed', { route: record.route });
      }
    };

    if (!provider) {
      await finish('error', route.model, { inputTokens: 0, outputTokens: 0 }, 'not_configured');
      throw new GatewayError('not_configured');
    }

    try {
      for await (const event of provider.stream(request, route, signal)) {
        if (event.type === 'done') {
          await finish(event.finishReason, event.model, event.usage);
        }
        yield event;
      }
    } catch (err) {
      const classified = classifyError(err);
      if (!finished)
        await finish('error', route.model, { inputTokens: 0, outputTokens: 0 }, classified.kind, {
          status: classified.status,
          code: classified.code,
        });
      throw classified;
    } finally {
      // 调用方提前停止读取（例如用户关掉页面）
      if (!finished)
        await finish('error', route.model, { inputTokens: 0, outputTokens: 0 }, 'aborted');
    }
  }

  /**
   * 结构化输出：按 zod 结构要求模型输出 JSON，并在本地再校验一次。
   * 不合格（解析失败、结构不符、被截断）时重试一次，仍不合格抛出 invalid_output。
   * 拒答直接返回 refused，不重试。不合格的原文不进日志。
   */
  async completeStructured<S extends z.ZodType>(
    ctx: C,
    request: Omit<GatewayRequest, 'responseFormat'>,
    format: { name: string; schema: S },
    signal?: AbortSignal,
  ): Promise<StructuredResult<z.output<S>>> {
    const jsonSchema: Record<string, unknown> = z.toJSONSchema(format.schema, { io: 'output' });
    // 厂商不需要元数据字段
    delete jsonSchema.$schema;
    const responseFormat = { name: format.name, schema: jsonSchema };
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt++) {
      const result = await this.complete(ctx, { ...request, responseFormat }, signal);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      const meta = { model: result.model, provider: result.provider, usage };
      if (result.finishReason === 'refused') return { status: 'refused', ...meta };
      const data = result.finishReason === 'complete' ? parseJson(result.text) : undefined;
      const parsed = data === undefined ? undefined : format.schema.safeParse(data);
      if (parsed?.success) return { status: 'ok', data: parsed.data, ...meta };
      this.options.logger?.error('llm structured output invalid', {
        route: request.route,
        attempt,
        finishReason: result.finishReason,
      });
    }
    throw new GatewayError('invalid_output');
  }

  /** 非流式调用：读完整个流再返回。 */
  async complete(ctx: C, request: GatewayRequest, signal?: AbortSignal): Promise<CompleteResult> {
    const provider = resolveRoute(this.options.config, request.route).provider;
    let text = '';
    for await (const event of this.stream(ctx, request, signal)) {
      if (event.type === 'text') text += event.delta;
      else
        return {
          text: event.finishReason === 'refused' ? '' : text,
          finishReason: event.finishReason,
          usage: event.usage,
          model: event.model,
          provider,
        };
    }
    throw new GatewayError('provider_error');
  }
}
