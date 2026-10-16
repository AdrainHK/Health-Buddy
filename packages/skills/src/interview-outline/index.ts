import { z } from 'zod';
import { loadSkillMd, parseSkillMeta, type SkillDefinition } from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import { appendRequest, describeReportClient } from '../report-input.js';

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
};
