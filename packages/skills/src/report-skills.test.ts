import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { suggestSkill } from './ask.js';
import { clientRecentSummary } from './client-recent-summary/index.js';
import { interviewOutline, type InterviewOutlineOutput } from './interview-outline/index.js';
import { interviewOutlineEvalCases } from './interview-outline/evals/cases.js';
import { assessmentPlanEvalCases } from './plan-evals.js';
import { GUARDRAILS, buildSystemPrompt, guardrails } from './guardrails.js';
import {
  CRITICAL_CALL_NOTICE,
  reportInterpretation,
  riskTierSuggestion,
  type ReportInterpretationOutput,
} from './report-interpretation/index.js';
import { reportInterpretationEvalCases } from './report-interpretation/evals/cases.js';
import { REPORT_SNAPSHOTS, RISK_TIER_CRITERIA_FIXTURE } from './report-fixtures.js';
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
    expect(prompt).toContain('不预设客户患有某种病');
    expect(prompt).toContain('不给用药建议');
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
      riskTierCriteria: RISK_TIER_CRITERIA_FIXTURE,
    });
    expect(msg).toContain(RISK_TIER_CRITERIA_FIXTURE);
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
    expect(without.professional).toContain('还没有确认的分层标准，这次不给出建议分层。');
    expect(without.professional).not.toContain('建议分层：');

    const input = {
      client: REPORT_SNAPSHOTS.singleAbnormal,
      managerRequest: '解读',
      riskTierCriteria: RISK_TIER_CRITERIA_FIXTURE,
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
      riskTierCriteria: RISK_TIER_CRITERIA_FIXTURE,
    });
    expect(msg).not.toContain('风险分层标准');
    expect(msg).toContain('空腹血糖：6.5 mmol/L');
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
    for (const p of assessmentPlanEvalCases) expect(getPlanTemplate(p.planId)).toBeDefined();
  });
});
