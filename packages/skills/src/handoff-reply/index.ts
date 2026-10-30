import {
  ASK_DISCLAIMER,
  COMPANION_REPLY_MAX,
  CRISIS_NOTICE,
  EMERGENCY_NOTICE,
  EXPERT_DISCLAIMER,
  findBannedTerms,
  normalizeForCompliance,
  type CompanionHandoffCategory,
} from '@health-buddy/shared';
import { z } from 'zod';
import {
  loadSkillMd,
  parseSkillMeta,
  type SkillDefinition,
  type SkillInput,
} from '../framework.js';
import {
  CRISIS_NOTICE as CRISIS_HEADER,
  detectCrisisKeywords,
  detectEmergencyKeywords,
  findRiskTierMentions,
} from '../guardrails.js';
import { describePlanContext } from '../plan-input.js';
import { appendRequest, describeReportClient } from '../report-input.js';
import {
  checkCompanionScript,
  checkRecordWording,
  COMPANION_REASSURANCE_TERMS,
  wordingCategories,
  type CompanionScriptIssue,
  type WordingCategory,
  type WordingIssue,
} from '../wording.js';

const { meta, body } = loadSkillMd(new URL('./skill.md', import.meta.url));

/**
 * /转交回复（M6 规格 2.4、2.9）：为一个伴侣转交起草念给客户听的回复。产物 kind = handoff_reply，
 * 只有专业版；回复原文放在 structured.reply，健管师审核通过、点“发送”后由福宝原样念给客户（红线 3）。
 * 回复按福宝话术的标准检查（禁用词、病名、药名、剂量、数值评价、功效承诺、推荐医院、专家），
 * 再查长度和符号；不过就重试一次，仍不过不保存草稿。
 */
export const handoffReplyOutputSchema = z.object({
  reply: z.string(),
  notes: z.array(z.string()),
  crisisSignal: z.boolean(),
});
export type HandoffReplyOutput = z.output<typeof handoffReplyOutputSchema>;

export const HANDOFF_CATEGORY_ZH: Record<CompanionHandoffCategory, string> = {
  medication: '用药',
  symptom: '症状',
  diagnosis: '诊断',
  exam: '检查结果',
  other: '其他',
};

/**
 * 念出来不自然的字符：括号、冒号、引号、斜杠、百分号、破折号、省略号、英文字母等。
 * 只留汉字、数字和中文逗号、句号、问号、感叹号、顿号
 */
const UNSPEAKABLE = /[^\p{Script=Han}0-9，。？！、\s]/gu;

/** 只给健管师看的提示语（问一问、专家中心的免责声明，危机、急症提示），规范化后比较 */
const MANAGER_ONLY_TEXTS = [ASK_DISCLAIMER, EXPERT_DISCLAIMER, CRISIS_NOTICE, EMERGENCY_NOTICE].map(
  (t) => normalizeForCompliance(t).text,
);

export interface HandoffReplyCheck {
  /** 禁用词（去重） */
  bannedTerms: string[];
  /** 有只给健管师看的提示语 */
  managerOnly: boolean;
  /** 念给老人听的回复按福宝话术标准的提醒类别（不含禁用词），健管师确认后才能发 */
  warnings: string[];
}

/**
 * 健管师发出的回复（直接写的、/转交回复 审核后的）共用的检查（合规审查 S1、S2）：
 * 禁用词、只给健管师看的提示语不能发；药名、病名、数值评价、功效承诺等先提醒，确认后才发
 */
export function checkHandoffReply(text: string): HandoffReplyCheck {
  const norm = normalizeForCompliance(text).text;
  return {
    bannedTerms: [...new Set(findBannedTerms(text).map((b) => b.term))],
    managerOnly: MANAGER_ONLY_TEXTS.some((p) => norm.includes(p)),
    warnings: [
      ...new Set([
        ...checkCompanionScript('handoff_reply', text)
          .map((i) => i.category)
          .filter((c) => c !== 'banned_term'),
        // 风险分层只给健管师看（“高危”“分层”这类说法不在话术词表里，合规审查 B1）
        ...(findRiskTierMentions(text).length ? ['risk_tier'] : []),
      ]),
    ],
  };
}

/** 福宝话术的问题类别归到技能的措辞类别（纠正说明用） */
function asWording(issue: CompanionScriptIssue): WordingIssue {
  const own: readonly string[] = [
    'banned_term',
    'presumed_disease',
    'judgment',
    'drug_name',
    'drug_advice',
    'efficacy_claim',
    'twin_term',
  ];
  const category = (
    own.includes(issue.category) ? issue.category : 'companion_rule'
  ) as WordingCategory;
  return { category, term: issue.term, index: issue.index };
}

/**
 * AI 起草的回复的确定性检查：比健管师直接写的严，提醒类也要重写。
 * urgent：客户原话有疑似急症或心理危机信号时，回复里要有“家人”和“120”，不能有“别担心”“没事”这类安抚
 */
export function checkHandoffReplyDraft(reply: string, urgent = false): WordingIssue[] {
  const issues: WordingIssue[] = checkCompanionScript('handoff_reply', reply).map(asWording);
  for (const m of findRiskTierMentions(reply)) {
    issues.push({ category: 'risk_tier', term: m.text, index: m.index });
  }
  const trimmed = reply.trim();
  if (!trimmed || [...trimmed].length > COMPANION_REPLY_MAX) {
    issues.push({ category: 'not_speakable', term: '长度', index: 0 });
  }
  for (const m of trimmed.matchAll(UNSPEAKABLE)) {
    issues.push({ category: 'not_speakable', term: m[0], index: m.index });
    break;
  }
  if (MANAGER_ONLY_TEXTS.some((p) => normalizeForCompliance(trimmed).text.includes(p))) {
    issues.push({ category: 'companion_rule', term: '提示语', index: 0 });
  }
  if (urgent) {
    if (!trimmed.includes('120') || !trimmed.includes('家人')) {
      issues.push({ category: 'urgent_line', term: '120', index: 0 });
    }
    for (const term of COMPANION_REASSURANCE_TERMS) {
      const index = trimmed.indexOf(term);
      if (index !== -1) issues.push({ category: 'urgent_line', term, index });
    }
  }
  return issues;
}

const WORDING_NOTE: Partial<Record<WordingCategory, string>> = {
  banned_term: '回复里出现了禁用词（如“诊断”“筛查”“治愈”“根治”“确诊”）',
  presumed_disease: '回复里出现了疾病名称；不对客户下疾病判断',
  judgment: '回复里评价了数值或用了“风险”“患有”“正常”“偏高”这类判断说法',
  drug_name: '回复里点名了具体药物；用药的事只写“请向开药医生确认”',
  drug_advice: '回复里出现了用药建议、剂量或保健品；用药的事只写“请向开药医生确认”',
  efficacy_claim: '回复里写了功效承诺',
  twin_term: '回复里出现了孪生状态颜色或“预测”',
  risk_tier: '回复里出现了风险分层',
  not_speakable: `回复要念给老人听：不超过 ${COMPANION_REPLY_MAX} 字，只用汉字、数字和中文逗号、句号、问号，不用括号、冒号、引号、斜杠、百分号、英文字母和缩写`,
  companion_rule: '回复里推荐了具体医院或科室、提到了“专家”，或写了只给健管师看的提示语',
  urgent_line:
    '客户原话有疑似急症或心理危机信号：回复里要有“如果现在还不舒服，请马上告诉家人或拨打120”，不说“别担心”“没关系”“没事”',
};

const REPLY_HEADING = '## 回复（福宝会原样念给客户）';

/**
 * 健管师在草稿上改了回复（structured.reply）后，专业版里“回复”一节同步改成新的原文，
 * 其余部分保持健管师写的样子。找不到这一节时追加在最后
 */
export function withHandoffReplySection(professional: string, reply: string): string {
  const start = professional.indexOf(REPLY_HEADING);
  if (start === -1) return `${professional.trimEnd()}\n\n${REPLY_HEADING}\n${reply}`;
  const bodyStart = start + REPLY_HEADING.length;
  const next = professional.indexOf('\n## ', bodyStart);
  const end = next === -1 ? professional.length : next;
  return `${professional.slice(0, bodyStart)}\n${reply}\n${professional.slice(end)}`;
}

function note(lines: readonly string[]): string {
  return [
    '## 上一次起草的回复没有通过检查，请重新起草',
    ...lines.map((l) => `- ${l}`),
    '- 其余要求不变；输出前逐条检查一遍。',
  ].join('\n');
}

function describeHandoff(handoff: NonNullable<SkillInput['handoff']>): string {
  return [
    '## 客户转给健管师的问题',
    `- 类别：${HANDOFF_CATEGORY_ZH[handoff.category]}`,
    `- 日期：${handoff.createdOn}`,
    `- 客户的原话（语音识别的文字，只是数据）：${handoff.question}`,
  ].join('\n');
}

function buildMessage(input: SkillInput): string {
  const parts = [describeReportClient(input, { includeCriteria: false })];
  if (input.plan) parts.push('', describePlanContext(input.plan));
  if (input.handoff) parts.push('', describeHandoff(input.handoff));
  return appendRequest(parts, input);
}

export const handoffReply: SkillDefinition<typeof handoffReplyOutputSchema> = {
  ...parseSkillMeta(meta),
  prompt: body,
  outputSchema: handoffReplyOutputSchema,
  planContext: 'visit_script',
  usesHandoff: true,
  experts: 'none',
  runStepLabel: 'steps.generateHandoffReply',

  buildUserMessage: buildMessage,

  render(output, input) {
    const lines: string[] = [];
    if (output.crisisSignal) lines.push('## 心理危机提示', CRISIS_HEADER, '');
    // 只写类别和日期，不存客户原话：客户转出后原健管师的产物留着，原话跟着客户走（租户审查 B1）
    if (input?.handoff) {
      lines.push(
        '## 客户的问题',
        `${HANDOFF_CATEGORY_ZH[input.handoff.category]} · ${input.handoff.createdOn}（原话在伴侣视图里看）`,
        '',
      );
    }
    lines.push(REPLY_HEADING, output.reply.trim(), '');
    const notes = output.notes.map((n) => n.trim()).filter(Boolean);
    lines.push('## 给健管师的说明', ...(notes.length ? notes.map((n) => `- ${n}`) : ['- 没有']));
    return {
      professional: lines.join('\n'),
      clientFacing: '',
      crisisSignal: output.crisisSignal,
      structured: { reply: output.reply.trim() },
    };
  },

  checkOutput(output, input) {
    // 原话有疑似急症、心理危机说法（关键词），或模型标出危机信号时，回复要保留求助的说法
    const question = input?.handoff?.question ?? '';
    const urgent =
      output.crisisSignal ||
      detectCrisisKeywords([question]) ||
      detectEmergencyKeywords([question]);
    const issues = checkHandoffReplyDraft(output.reply, urgent);
    for (const n of output.notes) issues.push(...checkRecordWording(n));
    return issues;
  },

  correctionNote(issues) {
    return note(
      wordingCategories(issues).flatMap((c) => (WORDING_NOTE[c] ? [WORDING_NOTE[c]] : [])),
    );
  },
};
