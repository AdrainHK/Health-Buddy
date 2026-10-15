import type {
  FinishReason,
  GatewayEvent,
  GatewayRequest,
  Provider,
  ProviderName,
  ResolvedRoute,
} from '../types.js';

export interface MockScript {
  chunks?: string[];
  finishReason?: FinishReason;
  usage?: { inputTokens: number; outputTokens: number };
  /** 输出若干块之后抛出这个错误，模拟中途断开 */
  failWith?: unknown;
}

/**
 * 测试和持续集成用的模拟厂商：不联网、不花钱。
 * 记录收到的请求，方便测试断言。
 */
export class MockProvider implements Provider {
  readonly calls: { request: GatewayRequest; route: ResolvedRoute }[] = [];

  constructor(
    readonly name: ProviderName = 'openai',
    private readonly script: MockScript = {},
  ) {}

  async *stream(request: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls.push({ request, route });
    const chunks = this.script.chunks ?? ['你好', '，我是', ' Health Buddy。'];
    for (const delta of chunks) {
      await Promise.resolve();
      yield { type: 'text', delta };
    }
    if (this.script.failWith !== undefined) throw this.script.failWith;
    yield {
      type: 'done',
      finishReason: this.script.finishReason ?? 'complete',
      usage: this.script.usage ?? { inputTokens: 12, outputTokens: chunks.length * 3 },
      model: route.model,
    };
  }
}
