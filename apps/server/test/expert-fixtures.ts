import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import type { ExpertOpinion, TaskStreamEvent } from '@health-buddy/shared';

/** 专家相关接口测试共用的模拟厂商和合成数据（M3） */

export type Reply =
  | { json: unknown }
  | { text: string }
  | { fail: true }
  | { refused: true }
  /** 一直等到被中止（模拟健管师点停止时专家还在回复） */
  | { hang: true };

/**
 * 按用途和专家 id 回答的模拟厂商（全部是合成数据）：专家并行调用，不能按调用次序排脚本。
 * 记录每次收到的请求，用来检查发给模型的内容里没有客户姓名。
 */
export class ExpertProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  /** 一个键可以给一串脚本：按次序用（模拟重试），用完后重复最后一条 */
  scripts: Record<string, Reply | Reply[]> = {};
  private readonly used = new Map<string, number>();

  reset(): void {
    this.calls.length = 0;
    this.scripts = {};
    this.used.clear();
  }

  async *stream(
    req: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const key = req.expertId ? `expert:${req.expertId}` : req.route;
    const script = this.scripts[key];
    const n = this.used.get(key) ?? 0;
    this.used.set(key, n + 1);
    const reply =
      (Array.isArray(script) ? script[Math.min(n, script.length - 1)] : script) ??
      DEFAULTS[req.route] ??
      ({ text: '{}' } as Reply);
    await Promise.resolve();
    if ('hang' in reply) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if ('fail' in reply) throw Object.assign(new Error('boom'), { status: 500 });
    const usage = { inputTokens: 10, outputTokens: 10 };
    if ('refused' in reply) {
      yield { type: 'done', finishReason: 'refused', usage, model: route.model };
      return;
    }
    yield { type: 'text', delta: 'json' in reply ? JSON.stringify(reply.json) : reply.text };
    yield {
      type: 'done',
      finishReason: 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }

  routes(): string[] {
    return this.calls.map((c) => (c.expertId ? `expert:${c.expertId}` : c.route));
  }
}

/** 合格的意见：不带数值、不带引用（来源还没确认，只能 data_only） */
export function opinion(summary = '该客户空腹血糖高于报告参考范围，建议关注饮食。'): ExpertOpinion {
  return {
    inScope: true,
    outOfScopeNote: null,
    summary,
    findings: [
      {
        point: '空腹血糖高于报告参考范围，比上次上升。',
        basis: 'data_only',
        dataRefs: [{ label: '空腹血糖', value: null, date: null }],
        citations: [],
      },
    ],
    suggestions: [{ text: '晚餐少吃甜食，每周快走几次。', category: 'lifestyle', citations: [] }],
    referral: { needed: false, urgency: null, to: null, reason: null },
    questionsToAsk: ['近期晚餐情况'],
    dataGaps: [],
    crisisSignal: false,
    emergencySignal: false,
  };
}

export const interpretationJson = {
  professional: {
    overview: '该客户这次报告有一项高于参考范围。',
    abnormalFindings: [{ indicator: '空腹血糖', observation: '比上次有所上升。' }],
    comparison: [],
    referralAdvice: null,
    riskTier: null,
    toUnderstand: [],
    missingData: [],
    interviewPoints: ['近期饮食'],
    suggestions: ['三个月后复查空腹血糖'],
  },
  clientFacing: '您好，这次体检有一项略高于报告上的参考范围。建议晚餐少吃甜食，每周快走三次。',
  crisisSignal: false,
};

const DEFAULTS: Record<string, Reply> = {
  expert: { json: opinion() },
  expert_routing: { json: { experts: [] } },
  expert_synthesis: {
    json: {
      consensus: [
        {
          point: '空腹血糖高于报告参考范围，建议关注饮食。',
          experts: ['endocrine-metabolism', 'nutrition'],
          citations: [],
        },
      ],
      disagreements: [],
      followUpPoints: ['近期晚餐情况'],
    },
  },
  report_interpretation: { json: interpretationJson },
  chat: { text: '合成回答。' },
};

export function parseSse(text: string): TaskStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as TaskStreamEvent);
}
