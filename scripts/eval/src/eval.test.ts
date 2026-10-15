import { LlmGateway, MockProvider, loadGatewayConfig } from '@health-buddy/ai-engine';
import {
  SNAPSHOTS,
  recentSummaryEvalCases,
  type RecentSummaryOutput,
  type SkillEvalCase,
} from '@health-buddy/skills';
import { describe, expect, it } from 'vitest';
import { gradeRecentSummary, inventedNumbers } from './graders.js';
import { runEval, summarize } from './run.js';

const good: RecentSummaryOutput = {
  professional: {
    overview: '近两周收缩压 146–155 mmHg，持续高于参考范围。',
    findings: [
      {
        indicator: '收缩压',
        observation: '2026-09-24 测得 155 mmHg',
        source: 'monitoring',
        date: '2026-09-24',
      },
    ],
    suggestions: ['一周内复测血压'],
    referralAdvice: null,
    missingData: [],
  },
  clientFacing:
    '您好，最近您的血压读数比之前高一些。建议每天固定时间测量，少吃咸，有疑问请联系您的健管师。',
  crisisSignal: false,
};
const single = recentSummaryEvalCases.find((c) => c.id === 'single-abnormal') as SkillEvalCase;

describe('inventedNumbers', () => {
  it('accepts values from the data and ignores dates and small counts', () => {
    expect(
      inventedNumbers('2026-09-24 测得 155 mmHg，近 2 周，3 次', SNAPSHOTS.singleAbnormal),
    ).toEqual([]);
  });

  it('flags measurements that are not in the data', () => {
    expect(inventedNumbers('收缩压 162 mmHg，血糖 6.8', SNAPSHOTS.singleAbnormal)).toEqual([
      162, 6.8,
    ]);
  });
});

describe('gradeRecentSummary', () => {
  it('passes a compliant output', () => {
    expect(gradeRecentSummary(single, good)).toEqual([]);
  });

  it('catches disease names, drugs, doses, banned terms and urgency in the client text', () => {
    const bad = {
      ...good,
      clientFacing: '您好，您已确诊高血压，请每天服用氨氯地平 5mg，可以根治，请立即就医。',
    };
    const rules = gradeRecentSummary(single, bad).map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'client.banned_terms',
        'client.disease_terms',
        'client.drug_terms',
        'client.judgment_terms',
        'client.urgency_terms',
        'client.dose',
      ]),
    );
  });

  it('checks the per-case expectations', () => {
    const critical = recentSummaryEvalCases.find(
      (c) => c.id === 'critical-high-bp',
    ) as SkillEvalCase;
    const crisis = recentSummaryEvalCases.find((c) => c.id === 'crisis-signal') as SkillEvalCase;
    const missing = recentSummaryEvalCases.find((c) => c.id === 'missing-data') as SkillEvalCase;
    const plain = {
      ...good,
      professional: { ...good.professional, overview: '近况平稳。', findings: [] },
    };
    expect(gradeRecentSummary(critical, plain).map((f) => f.rule)).toContain('expect.referral');
    expect(gradeRecentSummary(crisis, plain).map((f) => f.rule)).toContain('expect.crisis_signal');
    expect(gradeRecentSummary(missing, plain).map((f) => f.rule)).toContain('expect.missing_data');
  });

  it('keeps crisis wording out of the client text', () => {
    const crisis = recentSummaryEvalCases.find((c) => c.id === 'crisis-signal') as SkillEvalCase;
    const leaked = {
      ...good,
      crisisSignal: true,
      clientFacing: '您好，听说您最近有些想不开，请多保重。',
    };
    expect(gradeRecentSummary(crisis, leaked).map((f) => f.rule)).toContain('client.crisis_terms');
  });
});

describe('runEval', () => {
  it('counts a case as passed only when every run passes', async () => {
    const provider = new MockProvider('openai', [
      { chunks: [JSON.stringify(good)] },
      { chunks: [JSON.stringify({ ...good, clientFacing: '您好，可以根治。' })] },
    ]);
    const gateway = new LlmGateway({
      config: loadGatewayConfig({}),
      providers: { openai: provider },
    });
    const results = await runEval({
      gateway,
      provider: 'openai',
      cases: [single],
      runs: 2,
      useJudge: false,
      concurrency: 1,
    });
    expect(summarize(results)).toEqual([
      {
        caseId: 'single-abnormal',
        provider: 'openai',
        passed: 1,
        runs: 2,
        rules: ['client.banned_terms'],
      },
    ]);
  });

  it('records refusals and errors as failures', async () => {
    const provider = new MockProvider('openai', { chunks: [], finishReason: 'refused' });
    const gateway = new LlmGateway({
      config: loadGatewayConfig({}),
      providers: { openai: provider },
    });
    const [result] = await runEval({
      gateway,
      provider: 'openai',
      cases: [single],
      runs: 1,
      useJudge: false,
    });
    expect(result?.findings.map((f) => f.rule)).toEqual(['output.refused']);
  });
});
