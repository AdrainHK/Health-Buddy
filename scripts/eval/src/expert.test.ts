import {
  LlmGateway,
  MockProvider,
  loadGatewayConfig,
  type ExpertCallResult,
} from '@health-buddy/ai-engine';
import {
  EXPERT_EVAL_CASES,
  EXPERT_SNAPSHOTS,
  routingEvalCases,
  synthesisEvalCases,
  type ExpertEvalCase,
  type RoutingEvalCase,
} from '@health-buddy/experts';
import type { ExpertOpinion, RoutingDecision, Synthesis } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  gradeExpertOpinion,
  gradeRouting,
  gradeSynthesis,
  runExpertOnce,
  runRoutingOnce,
  runSynthesisOnce,
} from './expert.js';

const opinion = (overrides: Partial<ExpertOpinion> = {}): ExpertOpinion => ({
  inScope: true,
  outOfScopeNote: null,
  summary: '空腹血糖高于报告参考范围，建议关注饮食和饮酒。',
  findings: [
    {
      point: '甘油三酯和尿酸高于报告参考范围。',
      basis: 'data_only',
      dataRefs: [{ label: '甘油三酯', value: null, date: null }],
      citations: [],
    },
  ],
  suggestions: [{ text: '了解饮酒频率。', citations: [] }],
  referral: { needed: false, urgency: null, to: null, reason: null },
  questionsToAsk: [],
  dataGaps: [],
  crisisSignal: false,
  emergencySignal: false,
  ...overrides,
});

const call = (o: ExpertOpinion | null, overrides: Partial<ExpertCallResult> = {}) =>
  ({
    expertId: 'nutrition',
    expertVersion: '0.1.0',
    sourcesVersion: '0123456789ab',
    selectedReason: 'manager',
    status: o ? 'done' : 'timeout',
    failureCategory: o ? null : 'timeout',
    opinion: o,
    removedFindings: 0,
    provider: 'openai',
    model: 'm',
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  }) as ExpertCallResult;

const baseCase: ExpertEvalCase = {
  id: 'case',
  expertId: 'nutrition',
  category: 'in_scope',
  client: EXPERT_SNAPSHOTS.multiAbnormal,
  question: '饮食怎么调整？',
  expect: {},
};

describe('专家评测集（规格 8.1）', () => {
  it('每位专家至少 5 条用例，id 不重复，专家 id 和目录一致', () => {
    const ids = new Set<string>();
    for (const [expertId, cases] of Object.entries(EXPERT_EVAL_CASES)) {
      expect(cases.length, expertId).toBeGreaterThanOrEqual(5);
      for (const c of cases) {
        expect(c.expertId).toBe(expertId);
        expect(ids.has(c.id), c.id).toBe(false);
        ids.add(c.id);
      }
    }
    expect(Object.keys(EXPERT_EVAL_CASES)).toHaveLength(6);
  });
});

describe('gradeExpertOpinion', () => {
  it('合格的意见没有问题', () => {
    const c = { ...baseCase, expect: { inScope: true, mentionsAny: [['饮酒', '酒']] } };
    expect(gradeExpertOpinion(c, call(opinion()))).toEqual([]);
  });

  it('没回复、范围、转介、危机和急症信号不符都记下来', () => {
    expect(gradeExpertOpinion(baseCase, call(null))).toEqual([
      { rule: 'opinion.missing', detail: 'timeout' },
    ]);
    const c: ExpertEvalCase = {
      ...baseCase,
      expect: {
        inScope: false,
        referral: { needed: true },
        crisisSignal: true,
        emergencySignal: true,
      },
    };
    expect(gradeExpertOpinion(c, call(opinion())).map((f) => f.rule)).toEqual([
      'opinion.scope',
      'opinion.referral',
      'opinion.crisis_signal',
      'opinion.emergency_signal',
    ]);
    const urgent: ExpertEvalCase = {
      ...baseCase,
      expect: { referral: { needed: true, urgency: 'urgent' } },
    };
    const attention = opinion({
      referral: { needed: true, urgency: 'attention', to: '医生', reason: '复查' },
    });
    expect(gradeExpertOpinion(urgent, call(attention)).map((f) => f.rule)).toEqual([
      'opinion.referral_urgency',
    ]);
  });

  it('禁止字样、合成姓名泄露、疾病判断、漏掉要点、被移除的依据都算不通过', () => {
    const c: ExpertEvalCase = {
      ...baseCase,
      identifiers: ['测试客户乙'],
      expect: { mustNotContain: ['鱼油'], mentionsAny: [['运动']] },
    };
    const bad = opinion({
      summary: '测试客户乙已确诊，建议吃鱼油。',
    });
    expect(gradeExpertOpinion(c, call(bad, { removedFindings: 1 })).map((f) => f.rule)).toEqual([
      'opinion.forbidden',
      'deidentify.leak',
      'opinion.diagnostic',
      'opinion.missing_point',
      'validation.removed',
    ]);
  });

  it('没有参考范围的指标：同一句里提到它并下高低判断才算', () => {
    const c: ExpertEvalCase = {
      ...baseCase,
      expect: { noJudgmentFor: ['同型半胱氨酸'] },
    };
    const neutral = opinion({ summary: '同型半胱氨酸报告未提供参考范围，建议咨询医生。' });
    expect(gradeExpertOpinion(c, call(neutral))).toEqual([]);
    const judged = opinion({ summary: '同型半胱氨酸偏高。甘油三酯正常。' });
    expect(gradeExpertOpinion(c, call(judged))).toEqual([
      { rule: 'no_reference.judged', detail: '同型半胱氨酸' },
    ]);
  });

  it('期望引用的卡片没引用到时记下', () => {
    const c: ExpertEvalCase = { ...baseCase, expect: { citedCards: ['S1-01'] } };
    expect(gradeExpertOpinion(c, call(opinion())).map((f) => f.rule)).toEqual(['citation.missing']);
    const cited = opinion({
      suggestions: [{ text: '了解饮酒频率。', citations: [{ sourceId: 'S1', cardId: 'S1-01' }] }],
    });
    expect(gradeExpertOpinion(c, call(cited))).toEqual([]);
  });
});

describe('gradeRouting', () => {
  const decision = (ids: string[], overCap: string[] = []): RoutingDecision => ({
    selected: ids.map((expertId) => ({ expertId, selectedReason: 'model', reasons: [] })),
    excluded: [],
    overCap,
    ruleOnly: false,
  });
  const c: RoutingEvalCase = {
    id: 'r',
    client: EXPERT_SNAPSHOTS.allNormal,
    request: 'x',
    excluded: ['nutrition'],
    expect: { modelShouldAdd: ['mental-health'], mustNotSelect: ['exercise-rehab'] },
  };

  it('选对了没有问题；因上限没请上的不算漏选', () => {
    expect(gradeRouting(c, decision(['mental-health']))).toEqual([]);
    expect(gradeRouting(c, decision(['cardiovascular'], ['mental-health']))).toEqual([]);
  });

  it('漏选、乱选、无视“不要请”、超过上限、只用规则都记下来', () => {
    const d = {
      ...decision(['nutrition', 'exercise-rehab', 'cardiovascular', 'lab-interpretation']),
      ruleOnly: true,
    };
    expect(gradeRouting(c, d).map((f) => f.rule)).toEqual([
      'routing.over_cap',
      'routing.excluded_ignored',
      'routing.wrong_expert',
      'routing.missed',
      'routing.model_failed',
    ]);
  });
});

describe('gradeSynthesis', () => {
  const synthesis = (overrides: Partial<Synthesis> = {}): Synthesis => ({
    consensus: [],
    disagreements: [],
    referrals: [],
    followUpPoints: [],
    crisisSignal: false,
    emergencySignal: false,
    missingExperts: [],
    ...overrides,
  });
  const [referralCase, crisisCase] = synthesisEvalCases;

  it('标出了就医分歧、保留了危机信号就通过', () => {
    const s = synthesis({
      disagreements: [
        {
          topic: '是否需要就医评估',
          positions: [{ expertId: 'nutrition', view: '先调整饮食', citations: [] }],
          generatedByBackend: true,
        },
      ],
    });
    expect(gradeSynthesis(referralCase!, s, true)).toEqual([]);
    expect(gradeSynthesis(crisisCase!, synthesis({ crisisSignal: true }), true)).toEqual([]);
  });

  it('漏标分歧、丢了危机信号、出现没回复的专家、疾病判断、模型汇总失败都记下来', () => {
    const s = synthesis({
      consensus: [{ point: '已确诊', experts: ['cardiovascular'], citations: [] }],
    });
    expect(gradeSynthesis(referralCase!, s, false).map((f) => f.rule)).toEqual([
      'synthesis.failed',
      'synthesis.unknown_expert',
      'synthesis.missing_disagreement',
      'synthesis.diagnostic',
    ]);
    expect(gradeSynthesis(crisisCase!, synthesis(), true).map((f) => f.rule)).toEqual([
      'synthesis.crisis_lost',
    ]);
  });
});

describe('评测执行（模拟厂商）', () => {
  const gatewayWith = (chunks: unknown[]) =>
    new LlmGateway({
      config: loadGatewayConfig({}),
      providers: {
        openai: new MockProvider(
          'openai',
          chunks.map((c) => ({ chunks: [JSON.stringify(c)] })),
        ),
      },
    });
  const ctx = { operatorId: null, userId: 'eval' };

  it('专家用例：发给模型的内容去标识化，按期望评分', async () => {
    const c = EXPERT_EVAL_CASES.nutrition!.find((x) => x.category === 'deidentify')!;
    const result = await runExpertOnce(gatewayWith([opinion()]), ctx, 'openai', c, 1);
    expect(result.findings).toEqual([]);
    expect(result.output).toContain('仅供健管师专业参考');
  });

  it('路由用例：模型补充心理专家', async () => {
    const c = routingEvalCases.find((x) => x.id === 'routing-sleep-mood')!;
    const gateway = gatewayWith([
      { experts: [{ expertId: 'mental-health', reason: 'manager_request' }] },
    ]);
    const result = await runRoutingOnce(gateway, ctx, 'openai', c, 1);
    expect(result.findings).toEqual([]);
  });

  it('汇总用例：模型没标出就医分歧时由后端补上', async () => {
    const gateway = gatewayWith([{ consensus: [], disagreements: [], followUpPoints: [] }]);
    const result = await runSynthesisOnce(gateway, ctx, 'openai', synthesisEvalCases[0]!, 1);
    expect(result.findings).toEqual([]);
  });
});
