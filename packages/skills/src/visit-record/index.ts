import {
  DISCLAIMER,
  findBannedTerms,
  VISIT_FEEDBACK_TOPICS,
  VISIT_METHODS,
  isIsoDate,
  visitRecordStructuredSchema,
  type VisitRecordStructured,
} from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import { CRISIS_NOTICE } from '../guardrails.js';
import {
  VISIT_METHOD_ZH,
  describeMaterials,
  describePlanContext,
  describeVisit,
} from '../plan-input.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import {
  checkWhyWording,
  wordingCategories,
  type WordingCategory,
  type WordingIssue,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /随访记录（M5 规格 2.9）：把去标识后的随访素材整理成记录草稿，只有专业版，产物 kind = visit_record，
 * 结构化内容是 visitRecordStructuredSchema（健管师补填日期、方式后确认，确认时写入 visit_records）。
 * 只整理不添加：措辞检查不许疾病判断、用药建议；客户自己说的药名只能出现在“用药情况”一组。
 */
const HISTORY_CATEGORIES = [
  'past_history',
  'family_history',
  'medication',
  'allergy',
  'lifestyle',
] as const;

/** 长度上限由 visitRecordStructuredSchema 管（渲染时截断）；输出结构不带长度和数值范围（Claude 不接受） */
export const visitRecordOutputSchema = z.object({
  visitDate: z.string().nullable(),
  method: z.enum(VISIT_METHODS).nullable(),
  summary: z.string(),
  feedback: z.array(z.object({ topic: z.enum(VISIT_FEEDBACK_TOPICS), items: z.array(z.string()) })),
  planProgress: z.array(z.string()),
  agreements: z.array(z.string()),
  attentionPoints: z.array(z.string()),
  historySuggestions: z.array(
    z.object({ category: z.enum(HISTORY_CATEGORIES), content: z.string() }),
  ),
  openQuestions: z.array(z.string()),
  notes: z.array(z.string()),
  crisisSignal: z.boolean(),
});
export type VisitRecordOutput = z.output<typeof visitRecordOutputSchema>;

const FEEDBACK_ZH: Record<(typeof VISIT_FEEDBACK_TOPICS)[number], string> = {
  diet: '饮食',
  exercise: '运动',
  routine: '作息',
  mood: '心理和情绪',
  discomfort: '身体不适',
  medication: '用药情况',
  other: '其他',
};

const HISTORY_ZH: Record<(typeof HISTORY_CATEGORIES)[number], string> = {
  past_history: '既往史',
  family_history: '家族史',
  medication: '用药史',
  allergy: '过敏史',
  lifestyle: '生活习惯',
};

/** 客户说的用药情况（可以出现药名，只记录不评价） */
export function visitRecordMedicationTexts(output: VisitRecordOutput): string[] {
  return output.feedback.filter((f) => f.topic === 'medication').flatMap((f) => f.items);
}

/** 其余模型写的文字（不能点名药物、不能下疾病判断） */
export function visitRecordOtherTexts(output: VisitRecordOutput): string[] {
  return [
    output.summary,
    ...output.feedback.filter((f) => f.topic !== 'medication').flatMap((f) => f.items),
    ...output.planProgress,
    ...output.agreements,
    ...output.attentionPoints,
    // 用药史的条目照抄客户说的事实（可以有药名），同用药情况一样只查禁用词
    ...output.historySuggestions.filter((h) => h.category !== 'medication').map((h) => h.content),
    ...output.openQuestions,
    ...output.notes,
  ];
}

/** 结构校验：日期格式和不晚于今天（按“这一次随访”或系统给的今天）。返回类别：date_invalid */
export function validateVisitRecord(output: VisitRecordOutput, input?: SkillInput): string[] {
  const d = output.visitDate;
  if (d === null) return [];
  const today =
    input?.plan?.today ?? input?.plan?.schedule?.today ?? new Date().toISOString().slice(0, 10);
  // 时区差最多一天：比较时给“今天”留一天余量，和确认函数一致
  return !isIsoDate(d) || d > addOneDay(today) ? ['date_invalid'] : [];
}

function addOneDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const trimList = (items: readonly string[]) =>
  items
    .map((i) => i.trim())
    .filter(Boolean)
    .map((i) => i.slice(0, 500))
    .slice(0, 20);

/** 结构化内容：按契约截断长度、去掉空条目；日期不合格时留空让健管师填 */
export function visitRecordStructured(output: VisitRecordOutput): VisitRecordStructured {
  const visitDate = output.visitDate && isIsoDate(output.visitDate) ? output.visitDate : null;
  const feedback = VISIT_FEEDBACK_TOPICS.flatMap((topic) => {
    const items = trimList(
      output.feedback.filter((f) => f.topic === topic).flatMap((f) => f.items),
    );
    return items.length ? [{ topic, items }] : [];
  });
  return visitRecordStructuredSchema.parse({
    visitDate,
    method: output.method,
    summary: output.summary.trim().slice(0, 1000),
    feedback,
    planProgress: trimList(output.planProgress),
    agreements: trimList(output.agreements),
    attentionPoints: trimList(output.attentionPoints),
    historySuggestions: output.historySuggestions
      .map((h) => ({ category: h.category, content: h.content.trim().slice(0, 500) }))
      .filter((h) => h.content)
      .slice(0, 10),
    openQuestions: trimList(output.openQuestions),
  });
}

function list(items: readonly string[]): string[] {
  return items.length ? items.map((i) => `- ${i}`) : ['- 没有提到'];
}

const WORDING_NOTE: Partial<Record<WordingCategory, string>> = {
  banned_term: '记录里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease:
    '记录里把客户的描述写成了疾病名称；改写成“客户询问……相关问题”或照抄客户说的感受',
  judgment: '记录里用了“疑似”“患有”“风险”这类判断说法',
  drug_name: '药名只能出现在“用药情况”一组；其他地方写“用药调整请客户与医生确认”',
  drug_advice: '记录里出现了用药建议或剂量；客户说的用药只记录在“用药情况”一组，不评价',
};

const VALIDATION_NOTE: Record<string, string> = {
  date_invalid: 'visitDate 必须是 YYYY-MM-DD 格式、不晚于今天；不确定时写 null',
};

function note(lines: readonly string[]): string {
  return [
    '## 上一次整理的随访记录没有通过检查，请重新整理',
    ...lines.map((l) => `- ${l}`),
    '- 其余要求不变；输出前逐条检查一遍。',
  ].join('\n');
}

export const visitRecord: SkillDefinition<typeof visitRecordOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: body,
  outputSchema: visitRecordOutputSchema,
  planContext: 'visit_record',
  usesMaterials: true,
  experts: 'none',
  runStepLabel: 'steps.organizeVisitRecord',

  buildUserMessage(input) {
    const parts = [describeReportClient(input, { includeCriteria: false })];
    if (input.plan) {
      parts.push('', describePlanContext(input.plan), '', describeVisit(input.plan));
      if (input.plan.materials) parts.push('', describeMaterials(input.plan.materials));
    }
    return appendRequest(parts, input);
  },

  render(output) {
    const s = visitRecordStructured(output);
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_NOTICE, '');
    if (output.notes.length) lines.push('## 说明', ...list(output.notes.map((n) => n.trim())), '');
    lines.push(
      '## 随访信息',
      `- 日期：${s.visitDate ?? '（请填写）'}`,
      `- 方式：${s.method ? VISIT_METHOD_ZH[s.method] : '（请填写）'}`,
      '',
      '## 摘要',
      s.summary || '没有提到',
      '',
      '## 客户反馈的情况',
    );
    if (!s.feedback.length) lines.push('- 没有提到');
    for (const f of s.feedback) lines.push(`**${FEEDBACK_ZH[f.topic]}**`, ...list(f.items));
    lines.push(
      '',
      '## 方案执行情况',
      ...list(s.planProgress),
      '',
      '## 约定的事和下次随访建议',
      ...list(s.agreements),
      '',
      '## 需要健管师关注的点',
      ...list(s.attentionPoints),
      '',
      '## 建议更新健康史（逐条点“加入健康史”才写入）',
      ...list(s.historySuggestions.map((h) => `${HISTORY_ZH[h.category]}：${h.content}`)),
      '',
      '## 下次随访要了解的情况',
      ...list(s.openQuestions),
      '',
      '---',
      `只整理素材里客户和健管师说过的内容，确认后才写入随访记录。${DISCLAIMER}`,
    );
    return {
      professional: lines.join('\n'),
      clientFacing: '',
      crisisSignal: output.crisisSignal,
      structured: s,
    };
  },

  checkOutput(output) {
    const issues: WordingIssue[] = [];
    for (const t of visitRecordOtherTexts(output)) issues.push(...checkWhyWording(t));
    // 客户自己说的用药情况：可以有药名和“减少了”，只查禁用词
    const quoted = [
      ...visitRecordMedicationTexts(output),
      ...output.historySuggestions.filter((h) => h.category === 'medication').map((h) => h.content),
    ];
    for (const t of quoted) {
      issues.push(
        ...findBannedTerms(t).map((b) => ({
          category: 'banned_term' as const,
          term: b.term,
          index: b.index,
        })),
      );
    }
    return issues;
  },

  correctionNote(issues) {
    return note(
      wordingCategories(issues).flatMap((c) => (WORDING_NOTE[c] ? [WORDING_NOTE[c]] : [])),
    );
  },

  validateOutput: validateVisitRecord,

  validationNote(categories) {
    return note(categories.flatMap((c) => (VALIDATION_NOTE[c] ? [VALIDATION_NOTE[c]] : [])));
  },
};
