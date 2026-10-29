import type {
  FinishReason,
  GatewayEvent,
  GatewayRequest,
  Provider,
  ProviderName,
  ResolvedRoute,
  SynthesizeRequest,
  SynthesizeResult,
  TranscribeRequest,
  TranscribeResult,
} from '../types.js';

export interface MockScript {
  chunks?: string[];
  /** 按请求给出整段回答（优先于 chunks），用来模拟结构化输出 */
  respond?: (request: GatewayRequest) => string;
  finishReason?: FinishReason;
  usage?: { inputTokens: number; outputTokens: number };
  /** 输出若干块之后抛出这个错误，模拟中途断开 */
  failWith?: unknown;
  /** 每块之间等待的毫秒数，用来测试停止 */
  delayMs?: number;
}

/** 语音的模拟：识别返回固定文字，合成返回调用方给的音频（测试里一般是编好的 Ogg Opus） */
export interface MockSpeech {
  transcript?: string | ((request: TranscribeRequest) => string);
  synthesize?: (request: SynthesizeRequest) => Uint8Array;
  failWith?: unknown;
}

/**
 * 测试和持续集成用的模拟厂商：不联网、不花钱。
 * 记录收到的请求，方便测试断言。
 */
export class MockProvider implements Provider {
  readonly calls: { request: GatewayRequest; route: ResolvedRoute }[] = [];
  readonly speechCalls: { request: TranscribeRequest | SynthesizeRequest; route: ResolvedRoute }[] =
    [];
  /** 测试里可以直接改，用来模拟语音 */
  speech: MockSpeech = {};

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
    const chunks = script.respond
      ? [script.respond(request)]
      : (script.chunks ?? ['你好', '，我是', ' Health Buddy。']);
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

  async transcribe(request: TranscribeRequest, route: ResolvedRoute): Promise<TranscribeResult> {
    this.speechCalls.push({ request, route });
    await Promise.resolve();
    if (this.speech.failWith !== undefined) throw this.speech.failWith;
    const t = this.speech.transcript ?? '你好';
    return {
      text: typeof t === 'function' ? t(request) : t,
      usage: { inputTokens: 10, outputTokens: 2 },
      model: route.model,
    };
  }

  async synthesize(request: SynthesizeRequest, route: ResolvedRoute): Promise<SynthesizeResult> {
    this.speechCalls.push({ request, route });
    await Promise.resolve();
    if (this.speech.failWith !== undefined) throw this.speech.failWith;
    return {
      audio: this.speech.synthesize?.(request) ?? new Uint8Array(),
      usage: { inputTokens: 0, outputTokens: 0 },
      model: route.model,
    };
  }
}
