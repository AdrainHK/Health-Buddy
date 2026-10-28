import { DISCLAIMER } from '@health-buddy/shared';
import { z } from 'zod';
import { loadSkillMd, parseSkillMeta, type SkillDefinition } from '../framework.js';
import { CRISIS_NOTICE, findRiskTierMentions } from '../guardrails.js';
import { PLAN_SECTION_ZH, describePlanContext, describeVisit } from '../plan-input.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import { TWIN_PROMPT_RULES, describeTwin } from '../twin-input.js';
import {
  checkPlanClientText,
  checkRecordWording,
  checkTwinJudgments,
  wordingCategories,
  type WordingCategory,
  type WordingIssue,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /随访话术（M5 规格 2.8）：只有专业版（Q20），产物 kind = visit_script，没有结构化内容。
 * 说给客户听的话按面向客户的标准检查（复用方案通俗版的措辞检查），检查不过重试一次，仍不过不保存草稿。
 * 伴侣对话要点是占位（Q27），由后端固定写。
 */
const QUESTION_SECTIONS = ['diet', 'exercise', 'routine', 'mind', 'general'] as const;

export const visitScriptOutputSchema = z.object({
  summary: z.object({
    changes: z.array(z.string()),
    adherence: z.array(z.string()),
    followUps: z.array(z.string()),
    agreements: z.array(z.string()),
  }),
  opening: z.string(),
  questions: z.array(
    z.object({ section: z.enum(QUESTION_SECTIONS), question: z.string(), why: z.string() }),
  ),
  encouragement: z.array(z.string()),
  adjustments: z.array(z.string()),
  reminders: z.array(z.string()),
  notes: z.array(z.string()),
  crisisSignal: z.boolean(),
});
export type VisitScriptOutput = z.output<typeof visitScriptOutputSchema>;

/** 健管师要说给客户听的话（按面向客户的标准检查） */
export function visitScriptSpokenTexts(output: VisitScriptOutput): string[] {
  return [
    output.opening,
    ...output.questions.map((q) => q.question),
    ...output.encouragement,
    ...output.adjustments,
    ...output.reminders,
  ];
}

/** 只给健管师看的部分 */
export function visitScriptManagerTexts(output: VisitScriptOutput): string[] {
  const s = output.summary;
  return [
    ...s.changes,
    ...s.adherence,
    ...s.followUps,
    ...s.agreements,
    ...output.questions.map((q) => q.why),
    ...output.notes,
  ];
}

/** 不要说的话（固定提示，规格 2.8 第 3 条） */
export const VISIT_SCRIPT_DONT_SAY = [
  '不对客户下疾病判断，不说“您这是某某病”“风险很高”',
  '不评价用药，不建议停药、换药、加减药；用药问题请客户和开药的医生确认',
  '不承诺效果，不说“坚持就能降下来”“保证见效”',
  '不提风险分层、孪生状态颜色和预测',
];

const QUESTIONS_MIN = 3;
const QUESTIONS_MAX = 8;

/** 结构校验：问题数在 3–8 个之间，开场不为空。返回类别：questions_count、opening_empty */
export function validateVisitScript(output: VisitScriptOutput): string[] {
  const issues: string[] = [];
  const n = output.questions.filter((q) => q.question.trim()).length;
  if (n < QUESTIONS_MIN || n > QUESTIONS_MAX) issues.push('questions_count');
  if (!output.opening.trim()) issues.push('opening_empty');
  return issues;
}

function list(items: readonly string[]): string[] {
  const shown = items.map((i) => i.trim()).filter(Boolean);
  return shown.length ? shown.map((i) => `- ${i}`) : ['- 没有'];
}

const WORDING_NOTE: Partial<Record<WordingCategory, string>> = {
  banned_term: '话术里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease: '说给客户听的话里出现了疾病名称或人群说法；只问生活习惯和感受',
  judgment: '说给客户听的话里用了“风险”“患有”“疑似”这类判断说法',
  drug_name: '话术里点名了具体药物；只问“目前在用哪些药”',
  drug_advice: '话术里出现了用药建议、剂量或保健品',
  twin_term: '说给客户听的话里出现了孪生状态颜色或“预测”',
  risk_tier: '说给客户听的话里出现了风险分层',
  efficacy_claim: '说给客户听的话里写了功效承诺；写“有助于养成……的习惯”',
  status_change: '汇总里写了孪生状态的结论；状态只能由健管师在孪生上手动调整',
  forecast_certainty: '汇总里用了“将会”“一定会”这类确定说法',
  disease_risk: '汇总里把指标走势说成了疾病或患病概率',
};

const VALIDATION_NOTE: Record<string, string> = {
  questions_count: `要问的问题要有 ${QUESTIONS_MIN}–${QUESTIONS_MAX} 个`,
  opening_empty: '开场不能为空',
};

function note(lines: readonly string[]): string {
  return [
    '## 上一次生成的随访话术没有通过检查，请重新生成',
    ...lines.map((l) => `- ${l}`),
    '- 其余要求不变；输出前逐条检查一遍。',
  ].join('\n');
}

export const visitScript: SkillDefinition<typeof visitScriptOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: `${TWIN_PROMPT_RULES}\n\n${body}`,
  outputSchema: visitScriptOutputSchema,
  planContext: 'visit_script',
  experts: 'none',
  runStepLabel: 'steps.generateVisitScript',

  buildUserMessage(input) {
    const parts = [describeReportClient(input, { includeCriteria: false })];
    if (input.client.twin) parts.push('', describeTwin(input.client.twin));
    if (input.plan) parts.push('', describePlanContext(input.plan), '', describeVisit(input.plan));
    return appendRequest(parts, input);
  },

  render(output) {
    const s = output.summary;
    const lines: string[] = [DISCLAIMER, ''];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    if (output.notes.length) lines.push('## 说明', ...list(output.notes), '');
    lines.push(
      '## 随访前汇总',
      '**上次随访以来的变化**',
      ...list(s.changes),
      '',
      '**方案执行情况**',
      ...list(s.adherence),
      '',
      '**未处理的跟进项**',
      ...list(s.followUps),
      '',
      '**上次约定的事**',
      ...list(s.agreements),
      '',
      '**伴侣对话要点（M6 接入）**',
      '',
      '## 开场',
      output.opening.trim(),
      '',
      '## 要问的问题',
    );
    for (const section of QUESTION_SECTIONS) {
      const qs = output.questions.filter((q) => q.section === section && q.question.trim());
      if (!qs.length) continue;
      lines.push(`**${section === 'general' ? '其他' : PLAN_SECTION_ZH[section]}**`);
      for (const q of qs) lines.push(`- ${q.question.trim()}`, `  - 为什么问：${q.why.trim()}`);
    }
    lines.push(
      '',
      '## 鼓励和调整的说法',
      ...list([...output.encouragement, ...output.adjustments]),
      '',
      '## 需要提醒的事',
      ...list(output.reminders),
      '',
      '## 不要说的话',
      ...VISIT_SCRIPT_DONT_SAY.map((d) => `- ${d}`),
    );
    return { professional: lines.join('\n'), clientFacing: '', crisisSignal: output.crisisSignal };
  },

  checkOutput(output) {
    const issues: WordingIssue[] = [];
    for (const t of visitScriptSpokenTexts(output)) {
      issues.push(...checkPlanClientText(t));
      for (const m of findRiskTierMentions(t)) {
        issues.push({ category: 'risk_tier', term: m.text, index: m.index });
      }
    }
    for (const t of visitScriptManagerTexts(output)) {
      issues.push(...checkRecordWording(t), ...checkTwinJudgments(t));
    }
    return issues;
  },

  correctionNote(issues) {
    return note(
      wordingCategories(issues).flatMap((c) => (WORDING_NOTE[c] ? [WORDING_NOTE[c]] : [])),
    );
  },

  validateOutput: validateVisitScript,

  validationNote(categories) {
    return note(categories.flatMap((c) => (VALIDATION_NOTE[c] ? [VALIDATION_NOTE[c]] : [])));
  },
};
