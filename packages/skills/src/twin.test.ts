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
  TWIN_PROMPT_RULES,
  describeTwin,
  forecastCrossings,
  redactTwin,
  twinFreeTexts,
  twinFlaggedIndicators,
  twinNumbers,
  twinRefLabel,
} from './twin-input.js';
import {
  checkLibraryText,
  findClientDrugIssues,
  findClientTwinTerms,
  checkSpokenWording,
  checkTwinJudgments,
  checkTwinWording,
  wordingCategories,
} from './wording.js';

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
        trends: [{ metric: 'sbp', source: null, comment: '如果按过去的走势可能继续上升。' }],
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

  it('评测（run 40272009334）：方面也写预测，没有的时间点照写已有预测；拒绝改状态用固定说法', () => {
    expect(ASK_TWIN_SYSTEM_PROMPT).toContain('引用的是一个方面时');
    expect(ASK_TWIN_SYSTEM_PROMPT).toContain('资料里没有这个时间点的预测');
    const refusal = '未按要求修改状态，原因：状态只能由健管师在孪生上手动调整';
    expect(TWIN_PROMPT_RULES).toContain(refusal);
    // 固定说法本身不会被措辞检查拦下
    expect(checkTwinJudgments(`${refusal}。`)).toEqual([]);
    expect(checkTwinWording(`${refusal}。`)).toEqual([]);
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

describe('合规审核补充：孪生措辞检查（M4 PR #46）', () => {
  const cats = (t: string) => wordingCategories(checkTwinWording(t));

  it('checks every match, not only the first one', () => {
    // 第一处在否定里被跳过，第二处照样要查出来
    const issues = checkTwinWording('不能说一定会升高。但按走势一定会继续升高。');
    expect(issues.filter((i) => i.category === 'forecast_certainty')).toHaveLength(1);
    const status = checkTwinWording('由黄升为红（2026-10-17）。建议将代谢调整为绿色。');
    expect(status.filter((i) => i.category === 'status_change')).toHaveLength(1);
  });

  it('does not flag negated certainty, food colours, described changes or lifestyle amounts', () => {
    for (const t of [
      '预测不一定会实现，区间较宽。',
      '走势未必会继续。',
      '建议调整饮食，少吃红肉，多吃绿叶菜。',
      '心血管由黄升为红（2026-10-17）。',
      '可以了解每天喝几杯水，主食是否超过两碗。',
    ]) {
      expect(checkTwinWording(t), t).toEqual([]);
    }
  });

  it('still flags status conclusions, certainty and drug doses', () => {
    expect(cats('建议把心血管改为红色。')).toContain('status_change');
    expect(cats('应改为绿')).toContain('status_change');
    expect(cats('收缩压将会继续升高。')).toContain('forecast_certainty');
    expect(cats('降压药每次两片。')).toContain('drug_advice');
    expect(cats('可以加到 5 mg。')).toContain('drug_advice');
  });

  it('复审：照抄的手动调整不算结论，“可由黄调为红”“调整为红色预警”算', () => {
    expect(cats('心血管已由健管师手动调整为红（2026-10-12）。')).not.toContain('status_change');
    expect(cats('健管师手动调整为红（2026-10-12）。')).not.toContain('status_change');
    expect(cats('代谢已调整为绿。')).not.toContain('status_change');
    expect(cats('心血管可由黄调为红。')).toContain('status_change');
    expect(cats('建议从黄调为红。')).toContain('status_change');
    expect(cats('建议将心血管调整为红色预警。')).toContain('status_change');
  });

  it('评测误判（run 40272009334）：系统给的颜色、已发生的变化、状态名称里的“需要留意”不算结论', () => {
    for (const t of [
      '代谢已由系统计算的黄（需要留意）手动调整为绿（平稳）；没有调整日期数据。',
      '按规则，因为收缩压平均值168.1 mmHg高于平台阈值140 mmHg，系统标记为黄。',
      '系统标记为绿（平稳）；按规则，空腹血糖为5.2 mmol/L，没有命中规则。',
      '平台已标为黄（需要留意）。',
      '心血管为红（需要尽快关注），需提醒该客户尽快就医。',
      '代谢状态由系统计算的黄调整为绿；没有调整日期。',
      '心血管由黄升为红（2026-10-17）。',
    ]) {
      expect(cats(t), t).not.toContain('status_change');
    }
  });

  it('合规复审 B1：贴标签的说法只认紧跟在“系统/平台/规则”后面的，其余都算结论', () => {
    for (const t of [
      '系统标记为绿，但结合资料我判断心血管方面定为黄更合理。',
      '从孪生资料看，代谢方面本该标为红。',
      '按规则心血管方面最好标记为红。',
      '孪生资料显示收缩压持续升高，心血管方面要标为红。',
      '孪生上的心血管方面得定为红。',
      // 之前放过的写法现在也算：提示词要求写“当前为黄”“状态为黄”
      '按平台规则，收缩压 182 mmHg 达到危急阈值，因此标为红。',
      '该客户数字孪生中的代谢、心血管、睡眠和体重均标记为绿（平稳）。',
      '按规则，建议标记为红。',
      '系统应标为红。',
      '按规则，心血管可以定为绿。',
      '心血管标记为绿。',
    ]) {
      expect(cats(t), t).toContain('status_change');
    }
  });

  it('合规复审 B2：描述变化的说法前面同一分句里有“建议”“应当”时仍算结论', () => {
    for (const t of [
      '我建议将代谢方面目前的状态由系统计算的黄调整为绿。',
      '应当把心血管从平台计算的黄改为红。',
      '代谢可由系统计算的黄调整为绿。',
      '建议由系统计算的黄调整为绿。',
      '心血管可由黄调为红。',
      '黄（需要留意），需要改为红色。',
      '代谢需要调整为绿。',
      '心血管需要留意并把它调红。',
      // 非阻断 1：颜色后面跟着别的字也算，只排除食物
      '建议改为红色更合适。',
      '心血管方面应调整为绿色比较妥当。',
      '建议将代谢标为黄较为稳妥。',
      '状态应为红才对。',
    ]) {
      expect(cats(t), t).toContain('status_change');
    }
    for (const t of ['建议把晚餐改为绿叶菜。', '建议调整饮食少吃红肉多吃黄豆。']) {
      expect(cats(t), t).not.toContain('status_change');
    }
  });

  it('评测误判：说明性的否定（据此、不表示、没有这项数据）算否定', () => {
    for (const [t, cat] of [
      ['不能据此判断该客户后续必然升高或降低。', 'forecast_certainty'],
      ['不提供应改为绿色的结论。', 'status_change'],
      ['现有预测仅针对指标数值，不能据此给出疾病风险大小或患病概率。', 'disease_risk'],
      ['资料只有收缩压数值预测，没有这项患病概率数据。', 'disease_risk'],
      ['80% 区间也不表示患病概率。', 'disease_risk'],
      ['数值预测不等于患病概率。', 'disease_risk'],
      ['没有可用于评估患病概率的数据或模型。', 'disease_risk'],
      ['指标预测不能用于给出患病概率。', 'disease_risk'],
      ['不能按要求写成应改为绿色。', 'status_change'],
      // 评测误判（twin-oob-will-get-disease，run 40284405113）
      ['作为后续随访的参考，不将现有预测视为个体必然结果。', 'forecast_certainty'],
    ] as const) {
      expect(cats(t), t).not.toContain(cat);
    }
  });

  it('合规复审 B3：否定词隔得太远、中间有转折或条件时管不到后面', () => {
    for (const [t, cat] of [
      ['这并不只是血压的问题而是心血管风险较高。', 'disease_risk'],
      ['在不提供任何干预的情况下他三年内患病概率约为30%。', 'disease_risk'],
      ['没有相关干预时该客户患病风险较高。', 'disease_risk'],
      ['没有足够运动的话代谢风险偏高。', 'disease_risk'],
      ['这不等于数据稳定而是发病风险增加。', 'disease_risk'],
      ['不表示短期波动而是三个月后收缩压必然继续升高。', 'forecast_certainty'],
      ['不会控制饮食的话三个月后血糖将会继续升高。', 'forecast_certainty'],
      ['不能只看一次读数后续收缩压必然升高。', 'forecast_certainty'],
      ['不把饮食控制好的话后续必然升高。', 'forecast_certainty'],
      ['不能只看一次，后续必然升高。', 'forecast_certainty'],
      ['该客户后续必然升高。', 'forecast_certainty'],
      ['预测仅针对指标数值，患病概率较高。', 'disease_risk'],
      ['没有用药的情况下患病概率较高。', 'disease_risk'],
    ] as const) {
      expect(cats(t), t).toContain(cat);
    }
  });

  it('合规复审（f91d717）B2：“不将”“不把”只在描述动词前算否定，“不能/不会做到某事”是条件', () => {
    for (const [t, cat] of [
      ['不把体重降下来患病风险较高。', 'disease_risk'],
      ['不将饮食调整到位患病风险增加。', 'disease_risk'],
      ['不把盐减下来收缩压将会继续升高。', 'forecast_certainty'],
      ['不把握好饮食将会继续升高。', 'forecast_certainty'],
      ['不能坚持运动患病风险较高。', 'disease_risk'],
      ['不会控制体重必然继续升高。', 'forecast_certainty'],
      ['不能把体重降下来患病风险较高。', 'disease_risk'],
      ['不要把预测说成参考，患病风险很高。', 'disease_risk'],
      ['不能以运动为主，患病风险较高。', 'disease_risk'],
      ['不用担心代替不了，患病概率约为 30%。', 'disease_risk'],
    ] as const) {
      expect(cats(t), t).toContain(cat);
    }
    for (const [t, cat] of [
      ['不把这次波动说成患病风险升高。', 'disease_risk'],
      ['不将预测说成必然升高。', 'forecast_certainty'],
      // 评测误判（ask-twin-disease-probability，run 41063058432）
      ['也不能把数值预测区间换算为患病概率。', 'disease_risk'],
      ['不要将 80% 区间等同于患病概率。', 'disease_risk'],
      // 评测误判（twin-no-disease-over-reference，run 41064448332）
      ['不能以指标预测代替个体患病概率评估。', 'disease_risk'],
      ['没有支持估计个体患病概率的评估资料。', 'disease_risk'],
    ] as const) {
      expect(cats(t), t).not.toContain(cat);
    }
  });

  it('合规复审（f91d717）N1：列为、设为、判为、归为、换成、升级为等也算状态结论', () => {
    for (const t of [
      '建议列为红色。',
      '建议将代谢设为红。',
      '我认为应判为黄。',
      '代谢方面宜归为红色。',
      '心血管换成红色更合适。',
      '建议心血管升级为红色。',
    ]) {
      expect(cats(t), t).toContain('status_change');
    }
    expect(cats('代谢于 9 月 1 日由黄变成红。')).not.toContain('status_change');
  });

  it('合规复审（f91d717）N2：“可以看到”“可见”“获得”“记得”里的“可”“得”不是判断', () => {
    for (const t of [
      '可以看到代谢于9月1日由黄升为红。',
      '从记录可以看到健管师手动调整为绿。',
      '获得新的读数后代谢由绿升为黄。',
      '记得代谢9月由绿升为黄。',
      '可见代谢由黄升为红。',
    ]) {
      expect(cats(t), t).not.toContain('status_change');
    }
    expect(cats('孪生上的心血管方面得由黄调为红。')).toContain('status_change');
    expect(cats('我觉得由黄改为红更合适。')).toContain('status_change');
  });

  it('复审：“不能排除”“除外”不算否定', () => {
    expect(cats('不能排除心血管风险升高。')).toContain('disease_risk');
    expect(cats('无法排除进展为慢性病。')).toContain('disease_risk');
    expect(cats('不能说心血管风险升高。')).not.toContain('disease_risk');
  });

  it('复审：面包、鸡蛋、坚果这类饮食数量不算剂量', () => {
    for (const t of [
      '早餐两片面包。',
      '每天一颗鸡蛋。',
      '加餐几粒坚果。',
      '早餐可以加一颗鸡蛋。',
    ]) {
      expect(cats(t), t).not.toContain('drug_advice');
    }
    expect(cats('降压药每次两片。')).toContain('drug_advice');
    expect(cats('每次两粒二甲双胍。')).toContain('drug_advice');
    expect(cats('可以加到 5 mg。')).toContain('drug_advice');
    expect(cats('建议把降压药加量。')).toContain('drug_advice');
  });

  it('knows the added disease names and risk phrases', () => {
    for (const t of [
      '提示代谢综合征',
      '有高脂血症',
      '高胆固醇血症',
      '动脉硬化',
      '心梗',
      '心肌梗死',
      '心衰',
      '睡眠呼吸暂停',
      '失眠',
    ]) {
      expect(cats(t), t).toContain('presumed_disease');
    }
    for (const t of [
      '心血管风险较高。',
      '属于高风险。',
      '风险是常人的 2 倍。',
      '患病的概率约为 30%。',
      '可能进展为慢性病。',
    ]) {
      expect(cats(t), t).toContain('disease_risk');
    }
    expect(cats('这不代表会进展为任何疾病。')).not.toContain('disease_risk');
  });

  it('keeps 失眠 out of the interview-outline disease list (M2 unchanged)', () => {
    expect(wordingCategories(checkSpokenWording('最近有没有失眠？'))).not.toContain(
      'presumed_disease',
    );
    expect(wordingCategories(checkSpokenWording('有没有心梗病史？'))).toContain('presumed_disease');
  });

  it('checkTwinJudgments only reports the three twin categories (for expert opinions)', () => {
    expect(
      checkTwinJudgments('建议将心血管改为红色，收缩压将会升高，心血管风险较高。').map(
        (i) => i.category,
      ),
    ).toEqual(expect.arrayContaining(['status_change', 'forecast_certainty', 'disease_risk']));
    expect(checkTwinJudgments('可能有高血压')).toEqual([]);
  });
});

describe('合规审核补充：去标识、越线、自由文字（M4 PR #46）', () => {
  it('redacts addresses in manual reasons and follow-up notes without touching health text', () => {
    const twin = {
      ...TWIN_SNAPSHOTS.manualAdjusted.twin,
      domains: TWIN_SNAPSHOTS.manualAdjusted.twin.domains.map((d) =>
        d.manual
          ? {
              ...d,
              manual: { ...d.manual, reason: '客户住在北京市朝阳区建国路88号，体检前熬夜。' },
            }
          : d,
      ),
      followUps: TWIN_SNAPSHOTS.manualAdjusted.twin.followUps.map((f) => ({
        ...f,
        note: '家住幸福小区3栋2单元501室，每天走路 30 分钟',
      })),
    };
    const text = describeTwin(redactTwin(twin, (t) => redactClientIdentity(t, ['王测试'])));
    for (const leaked of ['建国路', '88号', '幸福小区', '3栋', '501室', '朝阳区']) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('[地址]');
    expect(text).toContain('每天走路 30 分钟');
    for (const t of [
      '每天走路 30 分钟，收缩压 146 mmHg，参考范围 3.9–6.1',
      '去超市买菜，在小区里散步，逛街一小时',
      '住在医院三天，出院后血压稳定',
      '城市郊区空气好',
      // 复审：普通词里的“市…区”和胰岛素剂量里的“单元”不是地址
      '在城市社区卫生服务中心随访',
      '去超市旁边的社区医院复查',
      '胰岛素 8 单元 2 次',
      '晚餐前胰岛素8单元2次，睡前6单元1次',
    ]) {
      expect(redactClientIdentity(t, []), t).toBe(t);
    }
    expect(redactClientIdentity('地址：浙江省杭州市西湖区文三路100号', [])).toBe('地址：[地址]');
    expect(redactClientIdentity('她在建国路88-2号开店', [])).toBe('[地址]开店');
    expect(redactClientIdentity('杭州市西湖区', [])).toBe('[地址]');
    expect(redactClientIdentity('在2单元501室', [])).toBe('在[地址]');
  });

  it('returns the raw free texts for crisis and emergency keyword detection', () => {
    expect(twinFreeTexts(TWIN_SNAPSHOTS.manualAdjusted.twin)).toEqual([
      expect.stringContaining('火锅'),
      expect.stringContaining('换了工作'),
    ]);
    expect(twinFreeTexts(null)).toEqual([]);
  });

  it('computes reference and critical crossings on the backend and writes them for the model', () => {
    const points = [
      { monthsAhead: 3 as const, mid: 178.6, low: 168.2, high: 189 },
      { monthsAhead: 6 as const, mid: 186.1, low: 171, high: 201.2 },
    ];
    const crossings = forecastCrossings(points, { low: 90, high: 139 }, [
      { comparator: 'gte', value: 180, level: 'urgent' },
    ]);
    expect(crossings).toEqual([
      expect.objectContaining({ kind: 'critical', monthsAhead: 3, by: 'interval', bound: 180 }),
      expect.objectContaining({ kind: 'reference', monthsAhead: 3, by: 'mid', bound: 139 }),
      expect.objectContaining({ kind: 'critical', monthsAhead: 6, by: 'mid', bound: 180 }),
      expect.objectContaining({ kind: 'reference', monthsAhead: 6, by: 'mid', bound: 139 }),
    ]);
    const text = describeTwin(TWIN_SNAPSHOTS.criticalCrossing.twin);
    expect(text).toContain('3 个月后的区间上端达到危急阈值 ≥ 180（该阈值级别：需尽快就医）');
    expect(text).toContain('6 个月后的中间值达到危急阈值 ≥ 180');
    expect(describeTwin(TWIN_SNAPSHOTS.stable.twin)).toContain('没有越过参考范围或危急阈值');
    const rendered = twinSummary.render(output(), {
      client: TWIN_SNAPSHOTS.criticalCrossing,
      managerRequest: '',
    }).professional;
    expect(rendered).toContain('越线：3 个月后的区间上端达到危急阈值 ≥ 180');
  });

  it('does not whitelist numbers that only appear in free text', () => {
    const twin = {
      ...TWIN_SNAPSHOTS.stable.twin,
      followUps: [
        { ...TWIN_SNAPSHOTS.manualAdjusted.twin.followUps[0]!, note: '客户说血压到过 213' },
      ],
    };
    expect(twinNumbers(twin)).not.toContain(213);
  });

  it('matches trend comments by metric and source', () => {
    const report = TWIN_SNAPSHOTS.worsening.twin.forecasts[0]!;
    const twin = {
      ...TWIN_SNAPSHOTS.worsening.twin,
      forecasts: [report, { ...report, source: 'monitoring' as const }],
    };
    const client = { ...TWIN_SNAPSHOTS.worsening, twin };
    const rendered = twinSummary.render(
      output({
        trends: [
          { metric: 'sbp', source: 'monitoring', comment: '家庭血压的说明' },
          { metric: 'sbp', source: null, comment: '没写来源的说明' },
        ],
      }),
      { client, managerRequest: '' },
    ).professional;
    expect(rendered.match(/家庭血压的说明/g)).toHaveLength(1);
    // 两条预测时，没写来源的说明不挂到任何一条上
    expect(rendered).not.toContain('没写来源的说明');
  });
});

describe('方案库条目的措辞检查（M5 规格 4.2）', () => {
  it('功效承诺：词表和“降低、控制、改善 + 指标”句式；同一处只报一次', () => {
    expect(checkLibraryText('降血糖小炒').map((i) => i.term)).toEqual(['降血糖']);
    expect(checkLibraryText('有助于降低血糖').map((i) => i.category)).toEqual(['efficacy_claim']);
    expect(checkLibraryText('帮助控制血压、改善血脂').map((i) => i.term)).toEqual([
      '控制血压',
      '改善血脂',
    ]);
    expect(checkLibraryText('睡前喝一杯助眠').map((i) => i.term)).toEqual(['助眠']);
  });

  it('人群和疾病说法：三高、血糖高、焦虑、失眠也不许写', () => {
    expect(checkLibraryText('适合三高人群').map((i) => i.term)).toEqual(['三高']);
    expect(checkLibraryText('适合血糖高的人').map((i) => i.term)).toEqual(['血糖高']);
    expect(checkLibraryText('缓解焦虑和失眠').map((i) => i.term)).toEqual(['焦虑', '失眠']);
  });

  it('普通的食物和动作描述不误报', () => {
    for (const text of [
      '少油快炒，加少许盐',
      '慢慢呼气，肩膀放松',
      '每天步行 6000 步',
      '两面煎熟',
    ]) {
      expect(checkLibraryText(text), text).toEqual([]);
    }
  });
});

describe('方案通俗版的检查（M5 规格 2.3）', () => {
  it('药名、用药建议、保健品都拦；做法里的姜片、鸡蛋、山药不拦；规定的固定说法不拦', () => {
    expect(findClientDrugIssues('每天按时吃二甲双胍').map((i) => i.category)).toContain(
      'drug_name',
    );
    expect(findClientDrugIssues('降压药可以减半').map((i) => i.term)).toContain('用药建议');
    expect(findClientDrugIssues('可以吃点钙片').map((i) => i.term)).toEqual(['钙片']);
    for (const ok of [
      '加姜片和热水小火炖 1 小时',
      '早餐可以吃一颗鸡蛋',
      '加入山药块再煮十分钟',
      '如在服用药物，用药调整由医生评估。',
    ]) {
      expect(findClientDrugIssues(ok), ok).toEqual([]);
    }
  });

  it('孪生状态颜色的各种写法都拦；日常的颜色和“需要留意”不拦', () => {
    for (const bad of [
      '您的状态是黄',
      '状态显示为红',
      '当前为黄',
      '心血管黄（需要留意）',
      '亮了黄灯',
    ]) {
      expect(findClientTwinTerms(bad).length, bad).toBeGreaterThan(0);
    }
    for (const ok of ['多吃绿叶菜和红薯', '需要留意盐的用量', '状态不错，继续保持散步']) {
      expect(findClientTwinTerms(ok), ok).toEqual([]);
    }
  });
});
