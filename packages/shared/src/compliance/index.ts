/**
 * 产品边界用词检查。
 *
 * 面向客户和宣传的文案不能把产品说成医疗诊断或治疗手段。
 * 这里只做确定性的词表匹配；语义层面的审查在 AI 评测和 compliance-reviewer 子代理里做。
 */

export interface BannedTerm {
  term: string;
  /** 写给开发者看的原因，也会出现在检查结果里。 */
  reason: string;
}

export const BANNED_TERMS: readonly BannedTerm[] = [
  { term: '诊断', reason: '产品不做医疗诊断，分析结果须标注“仅供参考，非医疗诊断”' },
  { term: '确诊', reason: '产品不做医疗诊断' },
  { term: '筛查', reason: '不能宣称具备疾病筛查能力' },
  { term: '治愈', reason: '不能承诺疗效' },
  { term: '根治', reason: '不能承诺疗效' },
  { term: '药到病除', reason: '不能承诺疗效' },
  { term: '包治', reason: '不能承诺疗效' },
];

/** 标准免责声明，所有分析、预测、专家意见都要带上。 */
export const DISCLAIMER = '仅供参考，非医疗诊断';

export interface ComplianceIssue {
  term: string;
  reason: string;
  /** 在原文中的起始位置（按 UTF-16 码元计）。 */
  index: number;
}

/**
 * 找出文案中的禁用词。
 * 标准免责声明“非医疗诊断”里的“诊断”是允许的，不算违规。
 */
export function findBannedTerms(text: string): ComplianceIssue[] {
  const masked = text.split(DISCLAIMER).join(' '.repeat(DISCLAIMER.length));
  const issues: ComplianceIssue[] = [];
  for (const { term, reason } of BANNED_TERMS) {
    let from = 0;
    for (;;) {
      const index = masked.indexOf(term, from);
      if (index === -1) break;
      issues.push({ term, reason, index });
      from = index + term.length;
    }
  }
  return issues.sort((a, b) => a.index - b.index);
}
