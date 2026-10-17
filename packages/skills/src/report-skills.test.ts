import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { suggestSkill } from './ask.js';
import { clientRecentSummary } from './client-recent-summary/index.js';
import { interviewOutline, type InterviewOutlineOutput } from './interview-outline/index.js';
import { interviewOutlineEvalCases } from './interview-outline/evals/cases.js';
import { assessmentPlanEvalCases } from './plan-evals.js';
import {
  GUARDRAILS,
  buildSystemPrompt,
  checkClientText,
  findRiskTierMentions,
  guardrails,
} from './guardrails.js';
import {
  CRITICAL_CALL_NOTICE,
  reportInterpretation,
  riskTierSuggestion,
  type ReportInterpretationOutput,
} from './report-interpretation/index.js';
import { reportInterpretationEvalCases } from './report-interpretation/evals/cases.js';
import { REPORT_SNAPSHOTS } from './report-fixtures.js';
import { indicatorName } from './indicators.js';
import { DEFAULT_RISK_TIER_GUIDE } from './risk-tier-guide.js';
import { checkSpokenWording, findDiseaseTerms } from './wording.js';
import { PLAN_TEMPLATES, SKILLS, getPlanTemplate, getSkill, skillSummaries } from './registry.js';

const interpretation = (
  overrides: Partial<ReportInterpretationOutput['professional']> = {},
): ReportInterpretationOutput => ({
  professional: {
    overview: '这次报告有一项高于参考范围。',
    abnormalFindings: [{ indicator: '空腹血糖', observation: '比去年有所上升。' }],
    comparison: ['空腹血糖 2025-09-10 5.9 → 2026-09-12 6.5 mmol/L'],
    referralAdvice: null,
    riskTier: { tier: 'medium', reasons: ['空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1'] },
    toUnderstand: [],
    missingData: ['报告没有糖化血红蛋白'],
    interviewPoints: ['近期饮食习惯'],
    suggestions: ['三个月后复查空腹血糖'],
    ...overrides,
  },
  clientFacing: '您好，这次体检大部分指标都在参考范围内。',
  crisisSignal: false,
});

/** OpenAI strict 模式：每个对象都关闭额外字段，且所有字段都必填 */
function expectStrict(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: 'output' });
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'object') {
      expect(n.additionalProperties).toBe(false);
      expect([...(n.required as string[])].sort()).toEqual(
        Object.keys(n.properties as object).sort(),
      );
    }
    Object.values(n).forEach(visit);
  };
  visit(json);
}

describe('M2 技能登记', () => {
  it('从 skill.md 读出 /体检解读 和 /面谈提纲 的元数据（规格 4.1）', () => {
    expect(reportInterpretation).toMatchObject({
      id: 'report-interpretation',
      kind: 'report_interpretation',
      title: '体检解读',
      requiresClient: true,
      modes: ['plan', 'craft'],
      clientFacing: true,
      involvesHealthJudgment: true,
      requiresReport: true,
    });
    expect(interviewOutline).toMatchObject({
      id: 'interview-outline',
      kind: 'interview_outline',
      title: '面谈提纲',
      requiresClient: true,
      modes: ['plan', 'craft'],
      clientFacing: false,
      involvesHealthJudgment: true,
      requiresReport: true,
    });
    expect(getSkill('report-interpretation')).toBe(reportInterpretation);
    expect(getSkill('interview-outline')).toBe(interviewOutline);
  });

  it('“新客户完整评估”是只能用于想一想的多步计划：解读 → 提纲（Q22）', () => {
    expect(getPlanTemplate('new-client-assessment')?.skills).toEqual([
      'report-interpretation',
      'interview-outline',
    ]);
    // 计划和技能的 id 不能重名，计划里的技能都要已登记并支持想一想
    for (const plan of PLAN_TEMPLATES) {
      expect(getSkill(plan.id)).toBeUndefined();
      for (const id of plan.skills) expect(getSkill(id)?.modes).toContain('plan');
    }
    const summary = skillSummaries().find((s) => s.id === 'new-client-assessment');
    expect(summary).toEqual({
      id: 'new-client-assessment',
      requiresClient: true,
      modes: ['plan'],
      clientFacing: true,
      involvesHealthJudgment: true,
      requiresReport: true,
      planSkills: ['report-interpretation', 'interview-outline'],
    });
    expect(skillSummaries().map((s) => s.id)).toEqual([...SKILLS.map((s) => s.id), summary?.id]);
  });

  it('自然语言里提到解读、面谈提纲时只建议对应的技能', () => {
    expect(suggestSkill('帮我解读一下这份报告')).toBe('report-interpretation');
    expect(suggestSkill('面谈的时候要问哪些')).toBe('interview-outline');
    expect(suggestSkill('写个近况小结')).toBe('client-recent-summary');
  });

  it('两个技能的输出结构都满足两家厂商的 strict 模式', () => {
    expectStrict(reportInterpretation.outputSchema);
    expectStrict(interviewOutline.outputSchema);
  });
});

describe('系统提示词', () => {
  it('M1 的共用规则不变；近况小结的提示词仍以它开头', () => {
    expect(guardrails()).toBe(GUARDRAILS);
    expect(buildSystemPrompt(clientRecentSummary).startsWith(GUARDRAILS)).toBe(true);
    expect(GUARDRAILS).toContain('只写“这项数据您的健管师会和您单独沟通”');
  });

  it('/体检解读：通俗版完全不提危急指标（Q19），可以照原文写报告参考范围（规格 2.5 示例）', () => {
    const prompt = buildSystemPrompt(reportInterpretation);
    expect(prompt).toContain('通俗版完全不提');
    expect(prompt).not.toContain('只写“这项数据您的健管师会和您单独沟通”');
    expect(prompt).toContain('可以照报告原文写报告上印的参考范围');
    expect(prompt).not.toContain('不写参考范围、阈值');
    for (const term of ['诊断', '筛查', '治愈', '根治']) expect(prompt).toContain(`“${term}”`);
    expect(prompt).toContain('不要写报告上没有印的参考范围');
  });

  it('/面谈提纲没有通俗版，不附通俗版规则', () => {
    const prompt = buildSystemPrompt(interviewOutline);
    expect(prompt).not.toContain('通俗版（clientFacing');
    expect(prompt).toContain('措辞规则（整份提纲都适用）');
    expect(prompt).toContain('未按要求给出用药建议，原因：用药调整需由医生评估');
  });
});

describe('/体检解读 的输入', () => {
  it('列出已核对指标、后端算好的高低标记、报告原文参考范围和历次数值', () => {
    const msg = reportInterpretation.buildUserMessage({
      client: REPORT_SNAPSHOTS.multiAbnormal,
      managerRequest: '帮我解读',
    });
    expect(msg).toContain('年龄段：50-59 岁；性别：男');
    expect(msg).toContain('当前风险分层（健管师设定，只给健管师看）：中（2026-03-01 设定）');
    expect(msg).toContain('生活习惯：应酬多，每周饮酒三到四次。');
    expect(msg).toContain('报告日期：2026-09-12');
    expect(msg).toContain(
      '甘油三酯：2.1 mmol/L；参考范围（报告原文）：<1.7；高于参考范围；之前：2025-09-10 1.8 mmol/L',
    );
    expect(msg).toContain(
      '高密度脂蛋白胆固醇：0.9 mmol/L；参考范围（报告原文）：>1.0；低于参考范围',
    );
    expect(msg).toContain('之前已核对的报告：2025-09-10');
    // 没有分层标准时明说，模型不给分层（规格 4.2）
    expect(msg).toContain('### 风险分层标准\n没有提供分层标准。');
  });

  it('没有参考范围的指标写明“报告未提供参考范围”，未收录指标用原始名称', () => {
    const msg = reportInterpretation.buildUserMessage({
      client: REPORT_SNAPSHOTS.missingReference,
      managerRequest: '解读',
    });
    expect(msg).toContain(
      '谷丙转氨酶：52 U/L；参考范围（报告原文）：报告未提供参考范围；报告未提供参考范围',
    );
    expect(msg).toContain('同型半胱氨酸（未收录指标）：16.8 umol/L');
    expect(msg).toContain('尿蛋白（未收录指标）：阴性');
    expect(msg).toContain('没有健康史记录。');
  });

  it('给了分层标准时原样附上', () => {
    const msg = reportInterpretation.buildUserMessage({
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '解读',
      riskTierCriteria: DEFAULT_RISK_TIER_GUIDE,
    });
    expect(msg).toContain(DEFAULT_RISK_TIER_GUIDE);
  });
});

describe('/体检解读 的产物', () => {
  it('异常项表由后端按输入写出：数值、报告参考范围、上次的数值', () => {
    const input = { client: REPORT_SNAPSHOTS.singleAbnormal, managerRequest: '解读' };
    const artifact = reportInterpretation.render(interpretation(), input);
    expect(artifact.professional).toContain(
      '- **空腹血糖**：6.5 mmol/L，高于参考范围（报告参考范围：3.9-6.1）；上次 2025-09-10 5.9 mmol/L',
    );
    expect(artifact.professional).toContain('## 历次对比');
    expect(artifact.professional).toContain('## 面谈时建议了解');
    expect(artifact.clientFacing).toBe('您好，这次体检大部分指标都在参考范围内。');
  });

  it('没有分层标准时丢弃模型给出的分层；有标准时给出建议和依据（规格 2.7、4.3）', () => {
    const output = interpretation();
    const without = reportInterpretation.render(output, {
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '解读',
    });
    expect(without.riskTierSuggestion).toBeNull();
    expect(without.professional).toContain('没有提供分层标准，这次不给出建议分层。');
    expect(without.professional).not.toContain('建议分层：');

    const input = {
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '解读',
      riskTierCriteria: DEFAULT_RISK_TIER_GUIDE,
    };
    const withCriteria = reportInterpretation.render(output, input);
    expect(withCriteria.riskTierSuggestion).toEqual({
      tier: 'medium',
      reason: '空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1',
    });
    expect(withCriteria.professional).toContain('建议分层：**中**');
    // 没有依据的分层不算建议
    expect(
      riskTierSuggestion(interpretation({ riskTier: { tier: 'high', reasons: [' '] } }), input),
    ).toBeNull();
    // 理由不超过分层历史的长度上限
    const long = riskTierSuggestion(
      interpretation({ riskTier: { tier: 'high', reasons: ['依'.repeat(600)] } }),
      input,
    );
    expect(long?.reason).toHaveLength(500);
  });

  it('危急指标写在专业版最前面，带“请先电话联系客户”的提示（Q19）', () => {
    const artifact = reportInterpretation.render(interpretation({ riskTier: null }), {
      client: REPORT_SNAPSHOTS.critical,
      managerRequest: '解读',
    });
    expect(artifact.professional).toContain(`## 危急指标\n**${CRITICAL_CALL_NOTICE}**`);
    expect(artifact.professional).toContain(
      '- 空腹血糖 17.2 mmol/L（2026-09-05，体检报告）：需尽快就医',
    );
    expect(artifact.professional.indexOf('## 危急指标')).toBeLessThan(
      artifact.professional.indexOf('## 总体概况'),
    );
  });
});

describe('/面谈提纲 的产物', () => {
  const output: InterviewOutlineOutput = {
    professional: {
      overview: '重点了解饮食和运动。',
      groups: [
        {
          topic: 'diet',
          questions: [
            { question: '您晚餐一般吃些什么？', why: '空腹血糖 6.5 mmol/L 高于报告参考范围' },
          ],
        },
        { topic: 'sleep', questions: [] },
      ],
      missingData: ['没有血压记录'],
      suggestions: [],
    },
    crisisSignal: false,
  };

  it('只有专业版，通俗版为空（规格 2.8）', () => {
    const artifact = interviewOutline.render(output, {
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '提纲',
    });
    expect(artifact.clientFacing).toBe('');
    expect(artifact.professional).toContain('## 饮食\n1. 您晚餐一般吃些什么？');
    expect(artifact.professional).toContain('为什么问：空腹血糖 6.5 mmol/L 高于报告参考范围');
    // 没有问题的主题不列
    expect(artifact.professional).not.toContain('## 睡眠');
  });

  it('输入里不带分层标准', () => {
    const msg = interviewOutline.buildUserMessage({
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '提纲',
      riskTierCriteria: DEFAULT_RISK_TIER_GUIDE,
    });
    expect(msg).not.toContain('风险分层标准');
    expect(msg).toContain('空腹血糖：6.5 mmol/L');
  });
});

describe('通俗版的确定性检查（Q20、规格 3.6）', () => {
  it('风险分层字样：插空格、全角、零宽字符和“高档”“低等级”都能找出，位置按原文', () => {
    const text = '您好，您属于中 风险人群，按高档管理，指标在低等级。分\u200b层见附件。';
    const found = findRiskTierMentions(text);
    expect(found.map((m) => m.text)).toEqual(['中 风险人群', '高档', '低等级', '分\u200b层']);
    for (const m of found) expect(text.slice(m.index, m.index + m.text.length)).toBe(m.text);
  });

  it('判断句式提示也先规范化：“糖 尿病”“高 血压”能标出，位置按原文', () => {
    const text = '您好，这不是糖 尿病，也不是高\u200b血压。';
    const hints = checkClientText(text).judgementHints;
    expect(hints.map((h) => h.text)).toEqual(['糖 尿病', '高\u200b血压']);
    for (const h of hints) expect(text.slice(h.index, h.index + h.text.length)).toBe(h.text);
  });
});

describe('/面谈提纲 保存前的措辞检查（规格 2.8）', () => {
  const outline = (question: string): InterviewOutlineOutput => ({
    professional: {
      overview: '重点了解饮食。',
      groups: [{ topic: 'family', questions: [{ question, why: '空腹血糖 6.5 mmol/L' }] }],
      missingData: [],
      suggestions: [],
    },
    crisisSignal: false,
  });

  it('疾病名称和禁用词都能找出（含插空格、繁体），位置按原文', () => {
    const text = '家里有人得过高 血压或糖尿病吗？做过篩查吗？';
    expect(findDiseaseTerms(text).map((d) => d.term)).toEqual(['高血压', '糖尿病']);
    const issues = checkSpokenWording(text);
    expect(issues.map((i) => [i.category, i.term])).toEqual([
      ['banned_term', '筛查'],
      ['presumed_disease', '高血压'],
      ['presumed_disease', '糖尿病'],
    ]);
    expect(text.slice(issues[1]!.index, issues[1]!.index + 4)).toBe('高 血压');
  });

  it('只检查问题；问症状和习惯的问题通过', () => {
    expect(
      interviewOutline.checkOutput?.(outline('家里的长辈有没有血压、血糖方面的问题？')),
    ).toEqual([]);
    const issues = interviewOutline.checkOutput?.(outline('您的糖尿病是什么时候诊断的？')) ?? [];
    expect(issues.map((i) => i.category).sort()).toEqual(['banned_term', 'presumed_disease']);
  });

  const withFields = (
    fields: Partial<{
      question: string;
      why: string;
      overview: string;
      suggestion: string;
      missing: string;
    }>,
  ): InterviewOutlineOutput => ({
    professional: {
      overview: fields.overview ?? '重点了解饮食。',
      groups: [
        {
          topic: 'diet',
          questions: [
            {
              question: fields.question ?? '您平时早餐一般吃什么？',
              why: fields.why ?? '空腹血糖 6.5 mmol/L 高于参考范围',
            },
          ],
        },
      ],
      missingData: fields.missing ? [fields.missing] : [],
      suggestions: fields.suggestion ? [fields.suggestion] : [],
    },
    crisisSignal: false,
  });
  const categories = (o: InterviewOutlineOutput) => [
    ...new Set((interviewOutline.checkOutput?.(o) ?? []).map((i) => i.category)),
  ];

  it.each([
    '建议换药',
    '可以吃点钙片',
    '停掉降压药',
    '建议停掉降压药',
    '把药减半',
    '建议暂停服药',
    '建议加大剂量',
    '建议吃阿司匹林',
    '建议改成二甲双胍',
    '可以换一种降压药',
    '降压药先别吃了',
    '建议您在医生指导下停药',
  ])('非问题部分的用药建议“%s”被拦下（跟进建议、重点、为什么问、缺少的信息）', (phrase) => {
    for (const fields of [
      { suggestion: phrase },
      { overview: phrase },
      { why: `空腹血糖 6.5 mmol/L，${phrase}` },
      { missing: phrase },
    ]) {
      const found = categories(withFields(fields));
      expect(found.some((c) => c === 'drug_advice' || c === 'drug_name')).toBe(true);
    }
  });

  it.each(['每次一片', '半粒', '两袋', '1/2 片', '三分之一片', '10 ml', '5 mg', '每天 300 g'])(
    '剂量“%s”被拦下（中文数字、分数也算）',
    (dose) => {
      expect(categories(withFields({ suggestion: `早餐后${dose}` }))).toContain('drug_advice');
      expect(categories(withFields({ question: `您平时${dose}吗？` }))).toContain('drug_advice');
    },
  );

  it.each([
    { suggestion: '建议少吃甜食' },
    { suggestion: '建议晚餐少吃甜食，把白米饭换成杂粮饭' },
    { suggestion: '未按要求给出用药建议，原因：用药调整需由医生评估' },
    { suggestion: '未按要求给出用药建议（原因：用药调整需由医生评估）' },
    { suggestion: '未按要求给出用药建议——用药调整需由医生评估' },
    { question: '目前在用哪些药和保健品？' },
    { question: '有没有医生开的长期用药？' },
    { suggestion: '建议吃燕麦片' },
    { suggestion: '早餐可以吃点面包片' },
    { question: '平时爱吃薯片吗？' },
    { why: '血红蛋白 130 g/L，空腹血糖 6.5 mmol/L，高于参考范围' },
    { missing: '健康史里没有用药记录' },
  ])('饮食建议、固定拒绝句、问用药情况和检验单位不算：%o', (fields) => {
    expect(interviewOutline.checkOutput?.(withFields(fields))).toEqual([]);
  });

  it('问题里的用药建议同样被拦下', () => {
    expect(categories(withFields({ question: '最近有没有自己停过药？' }))).toContain('drug_advice');
    expect(categories(withFields({ question: '是不是自己停过药？' }))).toContain('drug_advice');
  });

  it.each(['让他头疼时吃布洛芬', '建议吃布洛芬', '可以用布洛芬', '可以吃点布洛芬'])(
    '“%s”在每个字段都被拦下',
    (phrase) => {
      for (const fields of [
        { question: `${phrase}吗？` },
        { why: phrase },
        { overview: phrase },
        { missing: phrase },
        { suggestion: phrase },
      ]) {
        const found = categories(withFields(fields));
        expect(found).toContain('drug_name');
      }
      expect(categories(withFields({ suggestion: phrase }))).toContain('drug_advice');
    },
  );

  it.each(['降脂药', '止痛药', '感冒药', '安眠药', '对乙酰氨基酚'])('药名“%s”被拦下', (drug) => {
    expect(categories(withFields({ suggestion: `了解${drug}的情况` }))).toContain('drug_name');
  });

  it.each([
    '每天抽几支烟？',
    '每次喝几两白酒？',
    '每天喝几杯咖啡？',
    '每天放几勺盐？',
    '一天喝几瓶水？',
    '白酒每次喝几两？',
    '每天喝几杯水？',
    // 饮品：评测 39035850333 里提纲这样问
    '每天大概喝几杯水、几杯含糖饮料？',
    '每天喝几杯水、几杯咖啡？',
    '每天喝几杯奶茶或果汁？',
    '每天喝几杯冰可乐？',
    '每天喝几杯全脂牛奶？',
    '含糖饮料多久喝一次，每天大概喝几杯？',
    '酒多久喝一次，每天大概喝几杯？',
    '饮料平时喝得多吗？每天大概喝几杯？',
    '奶茶多久喝一次、每天大概喝几杯？',
  ])('生活方式的数量可以问：“%s”', (q) => {
    expect(categories(withFields({ question: `您${q}` }))).toEqual([]);
  });

  it.each([
    '保健品每天吃几片？',
    '鱼油两粒',
    '阿司匹林100mg',
    '每天吃几片钙片？',
    '喝几杯中药？',
    '每天几支维生素？',
    '每天喝几勺鱼油？',
    // 合规复审的反例：名单里的字出现在药名、药材或保健品里
    '茶里加几克三七粉',
    '保健酒每天喝几两',
    '每天喝几勺止咳糖浆',
    '每次几毫升止咳糖浆',
    '每次喝几瓶藿香正气水',
    '每天喝几袋口服补液盐',
    '睡前喝几杯水吃几颗褪黑素',
    '每天喝几两人参酒',
    '每天喝几杯降糖茶',
    '每天打几支针再抽烟',
    '每天喝几勺糖浆',
    '药酒每天喝几两',
    '酒多久喝一次，每天吃几片？',
    '饮料平时喝得多吗，每天大概喝几杯中药？',
    '水多久喝一次，吃药时每天喝几杯？',
    '每天喝几杯汤药？',
    '每天喝几袋冰糖浆？',
  ])('药和保健品的数量照样拦下：“%s”', (q) => {
    expect(categories(withFields({ suggestion: q }))).toContain('drug_advice');
  });

  it.each(['两颗', '一勺', '几片', '一包', '三丸'])('剂量“%s”被拦下', (dose) => {
    expect(categories(withFields({ suggestion: `每天${dose}` }))).toContain('drug_advice');
  });

  it('问题里的“风险”和为什么问里的判断说法被拦下', () => {
    expect(categories(withFields({ question: '您觉得自己的风险高吗？' }))).toEqual(['judgment']);
    expect(categories(withFields({ why: '客户疑似血糖偏高' }))).toEqual(['judgment']);
  });

  it('问题里的判断说法、扩充的疾病名称，以及为什么问里的禁用词和疾病名称都被拦下', () => {
    expect(categories(withFields({ question: '您得了多久了？' }))).toEqual(['judgment']);
    expect(categories(withFields({ question: '您疑似有什么情况吗？' }))).toEqual(['judgment']);
    for (const disease of ['肿瘤', '甲亢', '肾病', '哮喘', '骨质疏松', '贫血']) {
      expect(categories(withFields({ question: `家里有人有${disease}吗？` }))).toEqual([
        'presumed_disease',
      ]);
    }
    expect(categories(withFields({ why: '需要排除糖尿病' }))).toEqual(['presumed_disease']);
    expect(categories(withFields({ why: '为后续筛查做准备' }))).toEqual(['banned_term']);
    expect(categories(withFields({ question: '您的降糖药吃的什么剂量？' }))).toEqual(['drug_name']);
  });

  it('纠正说明只写问题类别，不复述上次的输出', () => {
    const issues = interviewOutline.checkOutput?.(outline('您的糖尿病是什么时候诊断的？')) ?? [];
    const note = interviewOutline.correctionNote?.(issues) ?? '';
    expect(note).toContain('没有通过措辞检查');
    expect(note).toContain('禁用词');
    expect(note).toContain('疾病名称');
    expect(note).not.toContain('什么时候');
  });
});

describe('M2 评测用例', () => {
  it('覆盖规格 4.4 的各类，且用例 id 不重复', () => {
    const all = [...reportInterpretationEvalCases, ...interviewOutlineEvalCases];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    const categories = new Set(reportInterpretationEvalCases.map((c) => c.category));
    for (const c of [
      'accuracy',
      'missing_reference',
      'critical_value',
      'risk_tier',
      'out_of_bounds',
    ])
      expect(categories.has(c as never), c).toBe(true);
    expect(reportInterpretationEvalCases.some((c) => c.returnReason)).toBe(true);
    expect(reportInterpretationEvalCases.some((c) => c.expect.riskTier === 'absent')).toBe(true);
    expect(interviewOutlineEvalCases.some((c) => c.category === 'out_of_bounds')).toBe(true);
    expect(interviewOutlineEvalCases.some((c) => c.returnReason)).toBe(true);
    for (const p of assessmentPlanEvalCases) expect(getPlanTemplate(p.planId)).toBeDefined();
    // 和上次相比变好、变差各有用例，并检查变化方向
    const trends = reportInterpretationEvalCases.flatMap((c) => c.expect.trends ?? []);
    expect(trends.some((t) => t.better === true)).toBe(true);
    expect(trends.some((t) => t.better === false)).toBe(true);
    // 分层：默认定义和另一套标准都有用例；没给标准时不输出分层
    const tierCases = reportInterpretationEvalCases.filter((c) => c.category === 'risk_tier');
    expect(new Set(tierCases.map((c) => c.riskTierCriteria ?? null)).size).toBe(3);
  });

  it('评测资料里变化方向和高低标记与数值一致', () => {
    const cases = reportInterpretationEvalCases.filter((c) => c.expect.trends?.length);
    for (const c of cases) {
      for (const t of c.expect.trends ?? []) {
        const row = c.client.reportDetail?.indicators.find((i) =>
          (i.code ? indicatorName(i.code) : (i.rawName ?? '')).includes(t.indicator),
        );
        expect(row, `${c.id} ${t.indicator}`).toBeDefined();
        const prev = row!.previous.at(-1)!.value;
        expect(row!.value! > prev ? 'up' : 'down', `${c.id} ${t.indicator}`).toBe(t.direction);
      }
    }
  });
});
