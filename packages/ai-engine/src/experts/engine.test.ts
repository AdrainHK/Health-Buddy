import type { ExpertOpinion } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from '../config.js';
import { LlmGateway } from '../gateway.js';
import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ProviderName,
  ResolvedRoute,
  UsageRecord,
} from '../types.js';
import { runConsultation } from './engine.js';
import { MEDICAL_REVIEW_TOPIC } from './synthesis.js';
import type { ConsultationInput, ConsultationRequest, ExpertProfile } from './types.js';
import { correctionNote, validateOpinion } from './validate.js';

/** 一次模型调用的脚本：返回的 JSON、拒答、出错或延迟 */
type Reply =
  { json: unknown; delayMs?: number } | { refused: true } | { fail: true } | { hang: true };

/**
 * 按用途和专家 id 回答的模拟厂商：并行调用的先后顺序不固定，不能按调用次序排脚本。
 * 同一个键给多条脚本时按次序用（模拟重试），用完后重复最后一条。
 */
class ScriptedProvider implements Provider {
  readonly calls: { route: string; expertId: string | undefined; request: GatewayRequest }[] = [];
  private readonly used = new Map<string, number>();

  constructor(
    readonly name: ProviderName,
    private readonly scripts: Record<string, Reply[]>,
  ) {}

  async *stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    const key = request.expertId ? `expert:${request.expertId}` : request.route;
    this.calls.push({ route: request.route, expertId: request.expertId, request });
    const list = this.scripts[key] ?? [];
    const n = this.used.get(key) ?? 0;
    this.used.set(key, n + 1);
    const reply = list[Math.min(n, list.length - 1)];
    const usage = { inputTokens: 100, outputTokens: 10 };
    if (!reply || 'fail' in reply) throw Object.assign(new Error('boom'), { status: 500 });
    if ('hang' in reply || ('delayMs' in reply && reply.delayMs)) {
      const ms = 'hang' in reply ? 10_000 : (reply.delayMs ?? 0);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if ('refused' in reply) {
      yield { type: 'done', finishReason: 'refused', usage, model: route.model };
      return;
    }
    if (!('json' in reply)) return;
    yield { type: 'text', delta: JSON.stringify(reply.json) };
    yield { type: 'done', finishReason: 'complete', usage, model: route.model };
  }
}

const card = (cardId: string, numbers: number[] = []) => ({
  cardId,
  sourceId: cardId.split('-')[0] ?? '',
  numbers,
});

function profile(id: string, codes: string[], cards = [card('S1-01', [7.0])]): ExpertProfile {
  return {
    id,
    name: `${id} 专家`,
    version: '0.1.0',
    sourcesVersion: 'sha-test',
    indicatorCodes: codes,
    historyCategories: [],
    maxOutputTokens: 1500,
    systemPrompt: `你是 ${id}`,
    catalog: { tagline: id, strengths: [id], outOfScope: ['药物'] },
    cards,
  };
}

const EXPERTS = [
  profile('endocrine-metabolism', ['fpg', 'hba1c', 'tg', 'tc', 'uric_acid', 'bmi']),
  profile('cardiovascular', ['sbp', 'dbp', 'heart_rate', 'tc', 'tg', 'ldl_c', 'hdl_c']),
  profile('nutrition', ['weight', 'bmi', 'fpg', 'tg', 'tc', 'uric_acid']),
  profile('exercise-rehab', []),
  profile('mental-health', []),
  profile('lab-interpretation', ['*']),
];

const INPUT: ConsultationInput = {
  userContent:
    '## 客户资料\n- 空腹血糖 6.8 mmol/L（高于参考范围 3.9-6.1）\n\n## 健管师的问题\n请看看',
  request: '请看看',
  flaggedIndicators: [
    { code: 'fpg', direction: 'high' },
    { code: 'tg', direction: 'high' },
  ],
  historyCategories: ['lifestyle'],
  allowedNumbers: [6.8, 3.9, 6.1, 2.3, 1.7],
  crisisDetected: false,
  emergencyDetected: false,
};

function opinion(overrides: Partial<ExpertOpinion> = {}): ExpertOpinion {
  return {
    inScope: true,
    outOfScopeNote: null,
    summary: '该客户空腹血糖 6.8 mmol/L，高于报告参考范围。',
    findings: [
      {
        point: '空腹血糖 6.8 mmol/L 高于报告参考范围 3.9-6.1。',
        basis: 'data_only',
        dataRefs: [{ label: '空腹血糖', value: '6.8 mmol/L', date: '2026-09-12' }],
        citations: [],
      },
    ],
    suggestions: [{ text: '建议复测空腹血糖。', citations: [] }],
    referral: { needed: false, urgency: null, to: null, reason: null },
    questionsToAsk: ['近期饮食情况'],
    dataGaps: [],
    crisisSignal: false,
    emergencySignal: false,
    ...overrides,
  };
}

const ctx = { operatorId: 'op-1', userId: 'manager-1' };

function setup(
  scripts: Record<string, Reply[]>,
  env: NodeJS.ProcessEnv = {},
  anthropicScripts?: Record<string, Reply[]>,
) {
  const openai = new ScriptedProvider('openai', scripts);
  const anthropic = new ScriptedProvider('anthropic', anthropicScripts ?? scripts);
  const records: UsageRecord[] = [];
  const gateway = new LlmGateway({
    config: loadGatewayConfig(env),
    providers: { openai, anthropic },
    recordUsage: (r) => {
      records.push(r);
    },
  });
  return { gateway, openai, anthropic, records };
}

function request(overrides: Partial<ConsultationRequest> = {}): ConsultationRequest {
  return {
    input: INPUT,
    available: EXPERTS,
    mode: 'route',
    forced: [],
    excluded: [],
    ...overrides,
  };
}

describe('expert routing', () => {
  it('selects rule hits first, by hit count, and skips the model when the cap is full', async () => {
    const { gateway, openai } = setup({
      'expert:endocrine-metabolism': [{ json: opinion() }],
      'expert:nutrition': [{ json: opinion() }],
      'expert:lab-interpretation': [{ json: opinion() }],
      expert_synthesis: [{ json: { consensus: [], disagreements: [], followUpPoints: [] } }],
    });
    const result = await runConsultation(gateway, ctx, request());
    expect(result.routing.selected.map((s) => s.expertId)).toEqual([
      'endocrine-metabolism',
      'nutrition',
      'lab-interpretation',
    ]);
    expect(result.routing.selected[0]?.reasons).toEqual([
      { kind: 'indicator', code: 'fpg', direction: 'high' },
      { kind: 'indicator', code: 'tg', direction: 'high' },
    ]);
    // 心血管只命中 1 项（甘油三酯），因上限未调用
    expect(result.routing.overCap).toEqual(['cardiovascular']);
    expect(openai.calls.some((c) => c.route === 'expert_routing')).toBe(false);
  });

  it('puts manager picks first, honours exclusions and asks the model to fill in', async () => {
    const { gateway, openai } = setup({
      expert_routing: [
        {
          json: {
            experts: [
              { expertId: 'mental-health', reason: 'manager_request' },
              { expertId: 'not-in-catalog', reason: 'manager_request' },
              { expertId: 'nutrition', reason: 'health_history' },
            ],
          },
        },
      ],
      'expert:exercise-rehab': [{ json: opinion() }],
      'expert:endocrine-metabolism': [{ json: opinion() }],
      'expert:mental-health': [{ json: opinion() }],
      expert_synthesis: [{ json: { consensus: [], disagreements: [], followUpPoints: [] } }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({
        forced: ['exercise-rehab'],
        excluded: ['nutrition', 'lab-interpretation', 'cardiovascular'],
      }),
    );
    expect(result.routing.selected).toEqual([
      { expertId: 'exercise-rehab', selectedReason: 'manager', reasons: [{ kind: 'manager' }] },
      expect.objectContaining({ expertId: 'endocrine-metabolism', selectedReason: 'rule' }),
      {
        expertId: 'mental-health',
        selectedReason: 'model',
        reasons: [{ kind: 'model', category: 'manager_request' }],
      },
    ]);
    expect(result.routing.excluded).toEqual(['nutrition', 'lab-interpretation', 'cardiovascular']);
    // 被排除的专家不出现在给路由模型的目录里
    const routingCall = openai.calls.find((c) => c.route === 'expert_routing');
    expect(JSON.stringify(routingCall?.request.messages)).not.toContain('id: nutrition');
    expect(openai.calls.some((c) => c.expertId === 'nutrition')).toBe(false);
  });

  it('falls back to rule routing when the routing model fails', async () => {
    const { gateway } = setup({
      expert_routing: [{ fail: true }],
      'expert:endocrine-metabolism': [{ json: opinion() }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({
        input: { ...INPUT, flaggedIndicators: [{ code: 'hba1c', direction: 'high' }] },
        available: EXPERTS.filter((e) => e.id !== 'lab-interpretation'),
      }),
    );
    expect(result.routing.ruleOnly).toBe(true);
    expect(result.routing.selected.map((s) => s.expertId)).toEqual(['endocrine-metabolism']);
    expect(result.status).toBe('done');
    expect(result.synthesisStatus).toBe('skipped');
  });

  it('calls nobody when neither rules nor the model pick anyone', async () => {
    const { gateway, openai } = setup({ expert_routing: [{ json: { experts: [] } }] });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ input: { ...INPUT, flaggedIndicators: [] } }),
    );
    expect(result.routing.selected).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(openai.calls.filter((c) => c.route === 'expert')).toHaveLength(0);
  });

  it('direct mode calls only the named experts without routing', async () => {
    const { gateway, openai } = setup({ 'expert:nutrition': [{ json: opinion() }] });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['nutrition'] }),
    );
    expect(result.calls.map((c) => c.expertId)).toEqual(['nutrition']);
    expect(openai.calls.map((c) => c.route)).toEqual(['expert']);
  });
});

describe('parallel calls and degradation', () => {
  it('times out one expert without affecting the others', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ hang: true }],
      'expert:nutrition': [{ json: opinion() }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
      { expertTimeoutMs: 50 },
    );
    const byId = Object.fromEntries(result.calls.map((c) => [c.expertId, c]));
    expect(byId['endocrine-metabolism']).toMatchObject({
      status: 'timeout',
      failureCategory: 'timeout',
    });
    expect(byId.nutrition?.status).toBe('done');
    expect(result.status).toBe('partial');
    expect(result.synthesis?.missingExperts).toEqual(['endocrine-metabolism']);
    expect(result.synthesisStatus).toBe('skipped');
  });

  it('records refusals and provider errors by category', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ refused: true }],
      'expert:nutrition': [{ fail: true }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
    );
    expect(result.calls.map((c) => [c.expertId, c.status, c.failureCategory])).toEqual([
      ['endocrine-metabolism', 'refused', 'refused'],
      ['nutrition', 'failed', 'provider_error'],
    ]);
    expect(result.status).toBe('failed');
    expect(result.synthesis).toBeNull();
  });

  it('stops every running call when the manager presses stop', async () => {
    const { gateway, openai } = setup({
      'expert:endocrine-metabolism': [{ hang: true }],
      'expert:nutrition': [{ json: opinion() }],
    });
    const stop = new AbortController();
    const finished: string[] = [];
    const running = runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
      {
        signal: stop.signal,
        hooks: { onCallFinished: (r) => void finished.push(`${r.expertId}:${r.status}`) },
      },
    );
    setTimeout(() => stop.abort(), 30);
    const result = await running;
    expect(result.status).toBe('stopped');
    expect(result.synthesis).toBeNull();
    expect(finished.sort()).toEqual(['endocrine-metabolism:stopped', 'nutrition:done']);
    expect(openai.calls.some((c) => c.route === 'expert_synthesis')).toBe(false);
  });

  it('queues calls through the concurrency limit', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ json: opinion(), delayMs: 10 }],
      'expert:nutrition': [{ json: opinion(), delayMs: 10 }],
      'expert:cardiovascular': [{ json: opinion(), delayMs: 10 }],
      expert_synthesis: [{ json: { consensus: [], disagreements: [], followUpPoints: [] } }],
    });
    let active = 0;
    let peak = 0;
    const queue: (() => void)[] = [];
    const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= 1) await new Promise<void>((r) => queue.push(r));
      active++;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active--;
        queue.shift()?.();
      }
    };
    const result = await runConsultation(
      gateway,
      ctx,
      request({
        mode: 'direct',
        forced: ['endocrine-metabolism', 'nutrition', 'cardiovascular'],
      }),
      { limit },
    );
    expect(peak).toBe(1);
    expect(result.status).toBe('done');
  });

  it('aborts the rest and rethrows when a hook fails', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ json: opinion() }],
      'expert:nutrition': [{ hang: true }],
    });
    await expect(
      runConsultation(
        gateway,
        ctx,
        request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
        {
          hooks: {
            onCallFinished: (r) => {
              if (r.expertId === 'endocrine-metabolism') throw new Error('task gone');
            },
          },
        },
      ),
    ).rejects.toThrow('task gone');
  });
});

describe('opinion validation in the engine', () => {
  const badCitation = opinion({
    findings: [
      {
        point: '按来源建议每周 150 分钟中等强度活动。',
        basis: 'cited',
        dataRefs: [],
        citations: [{ sourceId: 'S9', cardId: 'S9-01' }],
      },
      ...opinion().findings,
    ],
  });

  it('retries once with a category-only correction note, then accepts the fixed opinion', async () => {
    const { gateway, openai } = setup({
      'expert:nutrition': [{ json: badCitation }, { json: opinion() }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['nutrition'] }),
    );
    expect(result.calls[0]).toMatchObject({ status: 'done', removedFindings: 0 });
    const retry = openai.calls.filter((c) => c.expertId === 'nutrition')[1];
    const content = JSON.stringify(retry?.request.messages);
    expect(content).toContain('上一次输出没有通过检查');
    // 纠正说明不复述上次的输出
    expect(content).not.toContain('150 分钟');
  });

  it('drops the failing points after the retry and marks how many were removed', async () => {
    const { gateway } = setup({ 'expert:nutrition': [{ json: badCitation }] });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['nutrition'] }),
    );
    expect(result.calls[0]?.status).toBe('done');
    expect(result.calls[0]?.removedFindings).toBe(1);
    expect(result.calls[0]?.opinion?.findings).toHaveLength(1);
    expect(JSON.stringify(result.calls[0]?.opinion)).not.toContain('150');
    // 两次尝试的用量都计入
    expect(result.calls[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it('marks the whole opinion unusable when the summary invents a threshold', async () => {
    const { gateway } = setup({
      'expert:nutrition': [{ json: opinion({ summary: '空腹血糖超过 7.8 mmol/L 时需要关注。' }) }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['nutrition'] }),
    );
    expect(result.calls[0]).toMatchObject({ status: 'failed', failureCategory: 'invalid_output' });
    expect(result.status).toBe('failed');
  });
});

describe('synthesis', () => {
  const recommends = opinion({
    referral: {
      needed: true,
      urgency: 'attention',
      to: '内分泌科医生',
      reason: '空腹血糖高于参考范围',
    },
  });

  it('adds a backend disagreement on medical review and keeps every referral', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ json: recommends }],
      'expert:nutrition': [{ json: opinion() }],
      expert_synthesis: [
        {
          json: {
            consensus: [
              {
                point: '空腹血糖 6.8 mmol/L 高于参考范围。',
                experts: ['endocrine-metabolism', 'nutrition'],
                citations: [],
              },
            ],
            disagreements: [],
            followUpPoints: ['近期饮食情况'],
          },
        },
      ],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
    );
    expect(result.synthesisStatus).toBe('done');
    expect(result.synthesis?.referrals).toEqual([
      {
        expertId: 'endocrine-metabolism',
        urgency: 'attention',
        to: '内分泌科医生',
        reason: '空腹血糖高于参考范围',
      },
    ]);
    const generated = result.synthesis?.disagreements[0];
    expect(generated?.topic).toBe(MEDICAL_REVIEW_TOPIC);
    expect(generated?.generatedByBackend).toBe(true);
    expect(generated?.positions.map((p) => p.expertId)).toEqual([
      'endocrine-metabolism',
      'nutrition',
    ]);
    expect(result.synthesis?.consensus).toHaveLength(1);
  });

  it('removes synthesis items that add numbers or citations the experts never gave', async () => {
    const { gateway, openai } = setup({
      'expert:endocrine-metabolism': [{ json: opinion() }],
      'expert:nutrition': [{ json: opinion() }],
      expert_synthesis: [
        {
          json: {
            consensus: [
              { point: '目标值应低于 5.6 mmol/L。', experts: ['nutrition'], citations: [] },
              {
                point: '建议复测空腹血糖。',
                experts: ['nutrition'],
                citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
              },
              {
                point: '建议复测空腹血糖。',
                experts: ['nutrition', 'endocrine-metabolism'],
                citations: [],
              },
            ],
            disagreements: [],
            followUpPoints: [],
          },
        },
      ],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'nutrition'] }),
    );
    expect(result.synthesis?.consensus.map((c) => c.point)).toEqual(['建议复测空腹血糖。']);
    // 不合格时重试了一次
    expect(openai.calls.filter((c) => c.route === 'expert_synthesis')).toHaveLength(2);
  });

  it('lists raw opinions when synthesis fails, still merging referrals and crisis signals', async () => {
    const { gateway } = setup({
      'expert:endocrine-metabolism': [{ json: recommends }],
      'expert:mental-health': [{ json: opinion({ crisisSignal: true }) }],
      expert_synthesis: [{ fail: true }],
    });
    const result = await runConsultation(
      gateway,
      ctx,
      request({ mode: 'direct', forced: ['endocrine-metabolism', 'mental-health'] }),
    );
    expect(result.synthesisStatus).toBe('failed');
    expect(result.synthesis?.consensus).toEqual([]);
    expect(result.synthesis?.referrals).toHaveLength(1);
    expect(result.synthesis?.crisisSignal).toBe(true);
    expect(result.status).toBe('done');
  });

  it('carries backend-detected crisis and emergency signals even when no expert flags them', async () => {
    const { gateway } = setup({ 'expert:nutrition': [{ json: opinion() }] });
    const result = await runConsultation(
      gateway,
      ctx,
      request({
        mode: 'direct',
        forced: ['nutrition'],
        input: { ...INPUT, crisisDetected: true, emergencyDetected: true },
      }),
    );
    expect(result.synthesis?.crisisSignal).toBe(true);
    expect(result.synthesis?.emergencySignal).toBe(true);
  });
});

describe('gateway routes for both providers', () => {
  it('sends expert, routing and synthesis calls to the configured provider and meters expert ids', async () => {
    const scripts: Record<string, Reply[]> = {
      expert_routing: [{ json: { experts: [] } }],
      'expert:endocrine-metabolism': [{ json: opinion() }],
      'expert:nutrition': [{ json: opinion() }],
      expert_synthesis: [{ json: { consensus: [], disagreements: [], followUpPoints: [] } }],
    };
    const { gateway, openai, anthropic, records } = setup(
      scripts,
      {
        LLM_ROUTES: JSON.stringify({
          expert: { provider: 'anthropic' },
          expert_routing: { provider: 'openai', effort: 'low' },
          expert_synthesis: { provider: 'anthropic' },
        }),
      },
      scripts,
    );
    const result = await runConsultation(
      gateway,
      ctx,
      request({
        input: { ...INPUT, flaggedIndicators: [{ code: 'fpg', direction: 'high' }] },
        available: EXPERTS.filter((e) => e.id !== 'lab-interpretation'),
      }),
    );
    expect(result.status).toBe('done');
    expect(openai.calls.map((c) => c.route)).toEqual(['expert_routing']);
    expect(anthropic.calls.map((c) => c.route).sort()).toEqual([
      'expert',
      'expert',
      'expert_synthesis',
    ]);
    expect(result.calls.every((c) => c.provider === 'anthropic')).toBe(true);
    const expertRecords = records.filter((r) => r.route === 'expert');
    expect(expertRecords.map((r) => r.expertId).sort()).toEqual([
      'endocrine-metabolism',
      'nutrition',
    ]);
    // 计量只有 id 和数量，没有客户 id、任务 id 和原文
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(
        expect.arrayContaining(['route', 'provider', 'model', 'userId', 'operatorId']),
      );
      expect(JSON.stringify(r)).not.toContain('空腹血糖');
    }
  });
});

describe('validateOpinion', () => {
  const profileCards = { cards: [card('S1-01', [150]), card('S2-01')] };

  it('allows numbers from cited cards only where the card is cited', () => {
    const cited = opinion({
      findings: [
        {
          point: '来源建议每周 150 分钟中等强度身体活动。',
          basis: 'cited',
          dataRefs: [],
          citations: [{ sourceId: 'S1', cardId: 'S1-01' }],
        },
        {
          point: '每周 150 分钟。',
          basis: 'cited',
          dataRefs: [],
          citations: [{ sourceId: 'S2', cardId: 'S2-01' }],
        },
      ],
    });
    const check = validateOpinion(cited, profileCards, INPUT.allowedNumbers);
    expect(check.removed).toBe(1);
    expect(check.issues).toEqual(['invented_number']);
    expect(check.opinion?.findings).toHaveLength(1);
  });

  it('rejects cards from another source, guideline claims without cards and diagnostic wording', () => {
    const bad = opinion({
      findings: [
        {
          point: '空腹血糖偏高。',
          basis: 'cited',
          dataRefs: [],
          citations: [{ sourceId: 'S2', cardId: 'S1-01' }],
        },
        { point: '根据指南需要关注。', basis: 'data_only', dataRefs: [], citations: [] },
        { point: '该客户患有糖代谢问题。', basis: 'data_only', dataRefs: [], citations: [] },
        { point: '需 确 诊。', basis: 'data_only', dataRefs: [], citations: [] },
      ],
    });
    const check = validateOpinion(bad, profileCards, INPUT.allowedNumbers);
    expect(check.removed).toBe(4);
    expect(check.issues.sort()).toEqual(['bad_citation', 'banned_wording', 'unsupported_claim']);
  });

  it('keeps the referral when its text fails, and requires a note when out of scope', () => {
    const referral = opinion({
      referral: { needed: true, urgency: null, to: '内分泌科', reason: '超过 8.0 需要就医' },
    });
    const check = validateOpinion(referral, profileCards, INPUT.allowedNumbers);
    expect(check.opinion?.referral).toEqual({
      needed: true,
      urgency: 'attention',
      to: '内分泌科',
      reason: null,
    });
    const out = validateOpinion(
      opinion({ inScope: false, outOfScopeNote: null }),
      profileCards,
      [],
    );
    expect(out.fatal).toBe(true);
    const ok = validateOpinion(
      opinion({ inScope: false, outOfScopeNote: '用药调整请转介开药医生。' }),
      profileCards,
      INPUT.allowedNumbers,
    );
    expect(ok.opinion?.findings).toEqual([]);
  });

  it('writes correction notes by category only', () => {
    const note = correctionNote(['bad_citation', 'invented_number']);
    expect(note).toContain('只能引用清单里列出的卡片编号');
    expect(note).toContain('不要凭常识写阈值');
  });
});
