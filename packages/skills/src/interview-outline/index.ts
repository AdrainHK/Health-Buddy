import { z } from 'zod';
import { loadSkillMd, parseSkillMeta, type SkillDefinition } from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import {
  checkAdviceWording,
  checkSpokenWording,
  checkWhyWording,
  wordingCategories,
  type WordingCategory,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

export const OUTLINE_TOPICS = [
  'lifestyle',
  'diet',
  'exercise',
  'sleep',
  'medication',
  'family',
  'medical_care',
  'other',
] as const;

const TOPIC_ZH: Record<(typeof OUTLINE_TOPICS)[number], string> = {
  lifestyle: '生活习惯',
  diet: '饮食',
  exercise: '运动',
  sleep: '睡眠',
  medication: '正在用的药和保健品',
  family: '家族情况',
  medical_care: '就医情况',
  other: '其他',
};

/** /面谈提纲（M2 规格 2.8）：只有专业版，没有通俗版（clientFacing: false） */
export const interviewOutlineOutputSchema = z.object({
  professional: z.object({
    overview: z.string().min(1),
    groups: z.array(
      z.object({
        topic: z.enum(OUTLINE_TOPICS),
        questions: z.array(z.object({ question: z.string(), why: z.string() })),
      }),
    ),
    missingData: z.array(z.string()),
    suggestions: z.array(z.string()),
  }),
  crisisSignal: z.boolean(),
});
export type InterviewOutlineOutput = z.output<typeof interviewOutlineOutputSchema>;

export const interviewOutline: SkillDefinition<typeof interviewOutlineOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: body,
  outputSchema: interviewOutlineOutputSchema,
  requiresReport: true,
  runStepLabel: 'steps.generateOutline',

  buildUserMessage(input) {
    return appendRequest([describeReportClient(input, { includeCriteria: false })], input);
  },

  render(output, input) {
    const p = output.professional;
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    if (input?.client.reportDetail) {
      lines.push(`依据报告：${input.client.reportDetail.date}`, '');
    }
    lines.push('## 面谈重点', p.overview);
    for (const g of p.groups) {
      const questions = g.questions.filter((q) => q.question.trim());
      if (!questions.length) continue;
      lines.push('', `## ${TOPIC_ZH[g.topic]}`);
      questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.question.trim()}`);
        if (q.why.trim()) lines.push(`   - 为什么问：${q.why.trim()}`);
      });
    }
    if (p.missingData.length) {
      lines.push('', '## 档案里缺少的信息', ...p.missingData.map((s) => `- ${s}`));
    }
    if (p.suggestions.length) lines.push('', '## 跟进建议', ...p.suggestions.map((s) => `- ${s}`));
    // 没有通俗版：不能复制或导出给客户（规格 2.8、Q21）
    return { professional: lines.join('\n'), clientFacing: '', crisisSignal: output.crisisSignal };
  },

  /**
   * 问题是要对客户说的话：不能有禁用词、不能点名疾病和药物、不给用药建议（规格 2.8）。
   * 提纲的其他部分（重点、为什么问、缺少的信息、跟进建议）也不能有用药建议和剂量。
   */
  checkOutput(output) {
    const p = output.professional;
    const questions = p.groups.flatMap((g) => g.questions);
    return [
      ...questions.flatMap((q) => checkSpokenWording(q.question)),
      ...questions.flatMap((q) => checkWhyWording(q.why)),
      ...[p.overview, ...p.missingData, ...p.suggestions].flatMap((t) => checkAdviceWording(t)),
    ];
  },

  correctionNote(issues) {
    return outlineCorrectionNote(wordingCategories(issues));
  },
};

const CATEGORY_NOTE: Record<WordingCategory, string> = {
  banned_term: '问题里出现了禁用词（如“诊断”“筛查”“治愈”“根治”）',
  presumed_disease:
    '问题里点名了疾病名称（包括问家族史时），等于预设客户患病；改成问症状、习惯和测量情况，如“家里人有没有血压、血糖方面的问题”',
  judgment: '问题里用了“疑似”“患有”“得了”这类判断说法；只问症状、习惯和测量情况',
  drug_name: '提纲里点名了具体药物；用药只能问“目前在用哪些药和保健品”，其他部分写“用药情况”',
  drug_advice:
    '提纲里出现了用药建议或剂量（包括跟进建议和“未按要求”那一条）；不写服用、换药、停药、加减量和剂量，“未按要求”只写“未按要求给出用药建议”',
};

/**
 * 措辞检查没通过时，重新生成附在用户消息后面的纠正说明。只写问题类别，不复述上次的输出。
 */
export function outlineCorrectionNote(categories: readonly WordingCategory[]): string {
  return [
    '## 上一次生成的提纲没有通过措辞检查，请重新生成',
    ...categories.map((c) => `- ${CATEGORY_NOTE[c]}`),
    '- 其余要求不变；每个问题都按“问题的措辞”一节检查一遍再输出。',
  ].join('\n');
}
