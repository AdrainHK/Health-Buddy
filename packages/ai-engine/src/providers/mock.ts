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
  /** 每块之间等待的毫秒数，用来测试停止 */
  delayMs?: number;
}

/**
 * 测试和持续集成用的模拟厂商：不联网、不花钱。
 * 记录收到的请求，方便测试断言。
 */
export class MockProvider implements Provider {
  readonly calls: { request: GatewayRequest; route: ResolvedRoute }[] = [];

  /** 传一组脚本时，第 n 次调用用第 n 个（超出后重复最后一个），用来模拟重试 */
  constructor(
    readonly name: ProviderName = 'openai',
    private readonly scripts: MockScript | MockScript[] = {},
  ) {}

  private get script(): MockScript {
    if (!Array.isArray(this.scripts)) return this.scripts;
    return this.scripts[Math.min(this.calls.length - 1, this.scripts.length - 1)] ?? {};
  }

  async *stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    this.calls.push({ request, route });
    const script = this.script;
    const chunks = script.chunks ?? ['你好', '，我是', ' Health Buddy。'];
    for (const delta of chunks) {
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      else await Promise.resolve();
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text', delta };
    }
    if (script.failWith !== undefined) throw script.failWith;
    yield {
      type: 'done',
      finishReason: script.finishReason ?? 'complete',
      usage: script.usage ?? { inputTokens: 12, outputTokens: chunks.length * 3 },
      model: route.model,
    };
  }
}
