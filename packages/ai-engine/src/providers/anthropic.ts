import Anthropic from '@anthropic-ai/sdk';
import type {
  FinishReason,
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '../types.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

/**
 * Claude 适配器。
 * - 自适应思考（Opus 5.5 上始终开启），用 effort 控制深度
 * - 开启服务端 fallback：安全分类器误拦时由 Anthropic 推荐的模型接手，避免误报变成故障。
 *   走中转服务时不开：中转一般不支持这个 beta，也不一定有 fallback 用到的型号。
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly viaRelay: boolean;

  constructor(apiKey: string, client?: Anthropic, baseURL?: string) {
    this.client = client ?? new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.viaRelay = Boolean(baseURL);
  }

  async *stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    const stream = this.client.beta.messages.stream(
      {
        model: route.model,
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: route.effort,
          ...(request.responseFormat
            ? { format: { type: 'json_schema' as const, schema: request.responseFormat.schema } }
            : {}),
        },
        ...(this.viaRelay
          ? {}
          : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      signal ? { signal } : undefined,
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', delta: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    yield {
      type: 'done',
      finishReason: toFinishReason(message.stop_reason),
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      },
      // fallback 接手时这里是实际服务的型号
      model: message.model,
    };
  }
}

function toFinishReason(stopReason: string | null): FinishReason {
  if (stopReason === 'refusal') return 'refused';
  if (stopReason === 'max_tokens') return 'truncated';
  return 'complete';
}
