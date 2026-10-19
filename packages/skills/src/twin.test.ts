import { TWIN_DOMAINS } from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  ASK_SYSTEM_PROMPT,
  ASK_TWIN_SYSTEM_PROMPT,
  askSystemPrompt,
  buildAskUserContent,
  redactAskClient,
  suggestSkill,
} from './ask.js';
import { buildSystemPrompt, redactClientIdentity } from './guardrails.js';
import { knownNumbers } from './numbers.js';
import { getPlanTemplate, getSkill, skillSummaries } from './registry.js';
import { reportInterpretation } from './report-interpretation/index.js';
import { REPORT_SNAPSHOTS } from './report-fixtures.js';
import { twinAskEvalCases, twinSummaryEvalCases } from './twin-summary/evals/cases.js';
import { twinSummary, twinSummaryTexts, type TwinSummaryOutput } from './twin-summary/index.js';
import { TWIN_SNAPSHOTS, withFocus } from './twin-fixtures.js';
import {
  TWIN_LEVEL_ZH,
  describeTwin,
  redactTwin,
  twinFlaggedIndicators,
  twinNumbers,
  twinRefLabel,
} from './twin-input.js';
import { checkTwinWording, wordingCategories } from './wording.js';

const output = (over: Partial<TwinSummaryOutput['professional']> = {}): TwinSummaryOutput => ({
  professional: {
    overview: '心血管方面需要留意，其余方面平稳。',
    domains: TWIN_DOMAINS.map((domain) => ({ domain, explanation: '按规则计算。' })),
    changes: [],
    trends: [],
    followUps: [],
    suggestions: [],
    referralAdvice: null,
    dataGaps: [],
    ...over,
  },
  crisisSignal: false,
});

describe('/孪生小结 skill definition', () => {
  it('is professional-only, twin_summary, no experts, reads the twin', () => {
    expect(twinSummary).toMatchObject({
      id: 'twin-summary',
      kind: 'twin_summary',
      title: '孪生小结',
      requiresClient: true,
      modes: ['plan', 'craft'],
      clientFacing: false,
      involvesHealthJudgment: true,
      experts: 'none',
      usesTwin: true,
    });
    expect(getSkill('twin-summary')).toBe(twinSummary);
    // 专家预览开着也不接入专家（Q17）
    expect(skillSummaries(true).find((s) => s.id === 'twin-summary')?.experts).toBe('none');
    // 共用孪生规则拼在技能提示词里；没有通俗版的规则
    const system = buildSystemPrompt(twinSummary);
    expect(system).toContain('照抄资料里写的颜色');
    expect(system).not.toContain('通俗版（clientFacing');
  });

  it('plan template 孪生复盘 reads the twin and runs only /孪生小结', () => {
    expect(getPlanTemplate('twin-review')).toMatchObject({
      skills: ['twin-summary'],
      requiresClient: true,
      requiresReport: false,
      readsTwin: true,
    });
    const summary = skillSummaries(true).find((s) => s.id === 'twin-review');
    expect(summary).toMatchObject({ modes: ['plan'], clientFacing: false, experts: 'none' });
  });

  it('puts the twin (colours, basis, forecasts, follow-ups) into the user message', () => {
    const msg = twinSummary.buildUserMessage({
      client: TWIN_SNAPSHOTS.worsening,
      managerRequest: '请写小结',
    });
    expect(msg).toContain(`心血管：${TWIN_LEVEL_ZH.yellow}`);
    expect(msg).toContain(`睡眠：${TWIN_LEVEL_ZH.unknown}`);
    expect(msg).toContain('中间值 150.2，80% 区间 143.6–156.8');
    expect(msg).toContain('不确定性：一般');
    expect(msg).toContain('状态变差（由绿变黄）');
    expect(msg).toContain('高于报告上印的参考范围 90–139');
  });

  it('renders colours and forecast numbers from the input, not from the model', () => {
    const input = { client: TWIN_SNAPSHOTS.worsening, managerRequest: '请写小结' };
    // 模型在说明里自称“红色”也不会改变后端写的状态行
    const rendered = twinSummary.render(
      output({
        domains: [{ domain: 'cardiovascular', explanation: '按规则，收缩压高于参考范围。' }],
        trends: [{ metric: 'sbp', comment: '如果按过去的走势可能继续上升。' }],
      }),
      input,
    );
    expect(rendered.clientFacing).toBe('');
    expect(rendered.professional).toContain(`**心血管**：${TWIN_LEVEL_ZH.yellow} · 系统按规则计算`);
    expect(rendered.professional).toContain(`**睡眠**：${TWIN_LEVEL_ZH.unknown}`);
    expect(rendered.professional).toContain(
      '3 个月后中间值约 150.2 mmHg，80% 区间 143.6–156.8；6 个月后中间值约 154.4 mmHg，80% 区间 145.1–163.7',
    );
    expect(rendered.professional).toContain('不确定性一般');
    expect(rendered.professional).toContain('确认本小结不会改变任何状态');
    expect(rendered.professional).toContain('仅供参考，非医疗诊断');
  });

  it('writes 暂不预测 for insufficient data and the manual adjustment origin', () => {
    const insufficient = twinSummary.render(output(), {
      client: TWIN_SNAPSHOTS.insufficient,
      managerRequest: '',
    });
    expect(insufficient.professional).toContain(
      '数据不足，暂不预测（数据次数不够，还需要 2 次数据）',
    );
    const manual = twinSummary.render(output(), {
      client: TWIN_SNAPSHOTS.manualAdjusted,
      managerRequest: '',
    });
    expect(manual.professional).toContain(
      `**代谢**：${TWIN_LEVEL_ZH.green} · 健管师手动调整（系统计算：${TWIN_LEVEL_ZH.yellow}`,
    );
    expect(manual.professional).toContain('不确定性高');
  });

  it('opens with the critical notice when the twin has critical values', () => {
    const rendered = twinSummary.render(output(), {
      client: TWIN_SNAPSHOTS.critical,
      managerRequest: '',
    });
    expect(rendered.professional.startsWith('## 危急指标提醒')).toBe(true);
    expect(rendered.professional).toContain('收缩压 182 mmHg（2026-10-17，日常监测）：需尽快就医');
  });
});

describe('/孪生小结 wording checks', () => {
  it('flags status conclusions, certainty, disease risk, disease names and drugs', () => {
    const cats = (t: string) => wordingCategories(checkTwinWording(t));
    expect(cats('建议将代谢调整为红色。')).toContain('status_change');
    expect(cats('心血管状态应改为绿。')).toContain('status_change');
    expect(cats('3 个月后收缩压将会超过 150。')).toContain('forecast_certainty');
    expect(cats('按这个走势必然升高。')).toContain('forecast_certainty');
    expect(cats('3 个月后会发展成高血压。')).toEqual(
      expect.arrayContaining(['disease_risk', 'presumed_disease']),
    );
    expect(cats('心血管风险增加 20%。')).toContain('disease_risk');
    expect(cats('患病概率较高。')).toContain('disease_risk');
    expect(cats('建议明确诊断。')).toContain('banned_term');
    expect(cats('建议把降压药减半。')).toContain('drug_advice');
  });

  it('accepts neutral wording, change descriptions and the fixed refusal sentences', () => {
    const ok = [
      '心血管由绿变黄（2026-09-13），按规则，因为收缩压 146 mmHg 高于报告参考范围 90–139。',
      '如果按过去的走势，3 个月后收缩压可能继续上升，按当前走势可能高于报告参考范围，建议健管师关注和安排复查。',
      '未按要求修改状态，原因：状态由平台规则计算，只能由健管师在孪生上手动调整',
      '未按要求写疾病或患病概率，原因：预测只针对指标数值，不是对任何疾病的预测',
      '未按要求去掉不确定性，原因：每个预测都必须写明依据和不确定性',
      '未按要求写给客户的内容，原因：状态和预测只给健管师参考',
      '预测不代表会得任何疾病。',
    ];
    for (const t of ok) expect(checkTwinWording(t)).toEqual([]);
  });

  it('checks every model-written text', () => {
    const out = output({ suggestions: ['建议把心血管改为红色'] });
    expect(wordingCategories(twinSummary.checkOutput!(out))).toEqual(['status_change']);
    expect(twinSummaryTexts(out)).toContain('建议把心血管改为红色');
    expect(twinSummary.numberCheckTexts!(out)).toEqual(twinSummaryTexts(out));
    expect(twinSummary.correctionNote!(checkTwinWording('将会升高'))).toContain('确定说法');
  });
});

describe('twin input (5.2)', () => {
  it('removes names and phone numbers from manual reasons and follow-up notes', () => {
    const redact = (t: string) => redactClientIdentity(t, ['王测试']);
    const client = {
      ...TWIN_SNAPSHOTS.manualAdjusted,
      twin: redactTwin(TWIN_SNAPSHOTS.manualAdjusted.twin, redact),
    };
    const prompt = [
      buildSystemPrompt(twinSummary),
      twinSummary.buildUserMessage({ client, managerRequest: redact('王测试的小结') }),
      buildAskUserContent(redactAskClient(TWIN_SNAPSHOTS.manualAdjusted, redact), '王测试怎么样'),
    ].join('\n');
    // 问一问的 redactAskClient 只处理孪生；问题本身由后端另外去标识，这里只看孪生部分
    const twinPart = prompt.replace('王测试怎么样', '');
    expect(twinPart).not.toContain('王测试');
    expect(prompt).not.toMatch(/1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/);
    expect(prompt).toContain('该客户');
  });

  it('collects every twin number for the number check', () => {
    const nums = twinNumbers(TWIN_SNAPSHOTS.worsening.twin);
    for (const n of [146, 150.2, 143.6, 156.8, 154.4, 145.1, 163.7, 126, 139, 80]) {
      expect(nums).toContain(n);
    }
    // 历次数值的差
    expect(nums).toContain(20);
    const all = knownNumbers(TWIN_SNAPSHOTS.worsening);
    expect(all).toContain(150.2);
    expect(knownNumbers(null)).toEqual([]);
  });

  it('labels twin refs and derives routing indicators per domain or metric', () => {
    expect(twinRefLabel({ kind: 'domain', code: 'cardiovascular' })).toBe('孪生 · 心血管');
    expect(twinRefLabel({ kind: 'metric', code: 'weight' })).toBe('孪生 · 体重趋势');
    expect(
      twinFlaggedIndicators(TWIN_SNAPSHOTS.worsening.twin, [
        { kind: 'domain', code: 'cardiovascular' },
      ]),
    ).toEqual([{ code: 'sbp', direction: 'high', source: 'report' }]);
    // 睡眠只有监测指标（监测指标不交给“任何指标”的检验解读专家）
    expect(
      twinFlaggedIndicators(TWIN_SNAPSHOTS.manualAdjusted.twin, [
        { kind: 'domain', code: 'sleep' },
      ]),
    ).toEqual([{ code: 'sleep_hours', direction: 'low', source: 'monitoring' }]);
    expect(
      twinFlaggedIndicators(TWIN_SNAPSHOTS.stable.twin, [{ kind: 'metric', code: 'weight' }]),
    ).toEqual([{ code: 'weight', direction: 'high', source: 'monitoring' }]);
  });

  it('marks the focused twin refs', () => {
    const text = describeTwin(
      withFocus(TWIN_SNAPSHOTS.stable, [{ kind: 'metric', code: 'weight' }]).twin,
    );
    expect(text).toContain('这次引用的孪生项：孪生 · 体重趋势');
  });
});

describe('twin never reaches client-facing skills (5.4 第 3 条)', () => {
  it('/体检解读 ignores the twin even if the snapshot carries one', () => {
    const client = { ...REPORT_SNAPSHOTS.multiAbnormal, twin: TWIN_SNAPSHOTS.worsening.twin };
    const msg = reportInterpretation.buildUserMessage({ client, managerRequest: '请解读' });
    expect(msg).not.toContain('数字孪生');
    expect(msg).not.toContain('150.2');
  });
});

describe('ask with twin (2.8, 2.9)', () => {
  it('adds the twin to the ask context and switches the system prompt', () => {
    const client = withFocus(TWIN_SNAPSHOTS.worsening, [{ kind: 'metric', code: 'sbp' }]);
    const content = buildAskUserContent(client, '预测靠谱吗');
    expect(content).toContain('这次引用的孪生项：孪生 · 收缩压趋势');
    expect(content).toContain('## 健管师的问题\n预测靠谱吗');
    expect(askSystemPrompt(client)).toBe(ASK_TWIN_SYSTEM_PROMPT);
    expect(askSystemPrompt(undefined)).toBe(ASK_SYSTEM_PROMPT);
    expect(ASK_TWIN_SYSTEM_PROMPT.startsWith(ASK_SYSTEM_PROMPT)).toBe(true);
  });

  it('suggests /孪生小结 before /近况小结', () => {
    expect(suggestSkill('帮我写个孪生小结')).toBe('twin-summary');
    expect(suggestSkill('写个近况小结')).toBe('client-recent-summary');
  });
});

describe('twin eval cases', () => {
  it('has at least 15 /孪生小结 cases covering every category, unique ids', () => {
    expect(twinSummaryEvalCases.length).toBeGreaterThanOrEqual(15);
    const cats = new Set(twinSummaryEvalCases.map((c) => c.category));
    for (const c of [
      'status_copy',
      'forecast_wording',
      'no_disease_judgment',
      'critical_value',
      'out_of_bounds',
      'de_identification',
    ]) {
      expect(cats).toContain(c);
    }
    const ids = [...twinSummaryEvalCases, ...twinAskEvalCases].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of twinSummaryEvalCases) expect(c.client.twin).toBeTruthy();
    for (const c of twinAskEvalCases) expect(c.client.twin?.focus.length).toBeGreaterThan(0);
  });
});
