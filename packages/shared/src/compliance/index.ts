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

/** 零宽字符：插在词中间可以绕过简单的字符串匹配。 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;

interface Normalized {
  text: string;
  /** 规范化后每个字符对应的原文位置 */
  origin: number[];
}

/**
 * 匹配前先规范化：去掉空白和零宽字符，全角转半角（NFKC）。
 * 同时记下每个字符在原文中的位置，便于把问题标回原文。
 */
function normalize(text: string): Normalized {
  let out = '';
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    if (!/\s/.test(ch) && !ZERO_WIDTH.test(ch)) {
      for (const n of ch.normalize('NFKC')) {
        out += n;
        for (let k = 0; k < n.length; k++) origin.push(i);
      }
    }
    i += ch.length;
  }
  return { text: out, origin };
}

/**
 * 找出文案中的禁用词。
 * 匹配前去掉空格和零宽字符、统一全角半角，“筛 查”“根\u200B治”这类写法同样会被找出。
 * 标准免责声明“非医疗诊断”里的“诊断”是允许的，不算违规。
 */
export function findBannedTerms(text: string): ComplianceIssue[] {
  const { text: norm, origin } = normalize(text);
  const disclaimer = normalize(DISCLAIMER).text;
  const masked = norm.split(disclaimer).join(' '.repeat(disclaimer.length));
  const issues: ComplianceIssue[] = [];
  for (const { term, reason } of BANNED_TERMS) {
    let from = 0;
    for (;;) {
      const index = masked.indexOf(term, from);
      if (index === -1) break;
      issues.push({ term, reason, index: origin[index] ?? 0 });
      from = index + term.length;
    }
  }
  return issues.sort((a, b) => a.index - b.index);
}

/** 文案是否以标准免责声明结尾（忽略末尾空白）。 */
export function endsWithDisclaimer(text: string): boolean {
  return text.trimEnd().endsWith(DISCLAIMER);
}
