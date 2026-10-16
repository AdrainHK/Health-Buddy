import { findBannedTerms, normalizeForCompliance } from '@health-buddy/shared';

/**
 * 面向客户说出口的话（面谈提纲的问题）的确定性措辞检查（M2 规格 2.8）。
 * 后端保存前检查，评测的规则检查用同一份词表，两边不会不一致。
 * 结果只有类别和位置，不带原文以外的内容；日志里只记类别。
 */

/** 疾病名称：问题里出现就算预设客户患病（了解家族情况也不点名疾病） */
export const DISEASE_TERMS = [
  '高血压',
  '低血压',
  '糖尿病',
  '高血脂',
  '血脂异常',
  '高尿酸血症',
  '痛风',
  '脂肪肝',
  '冠心病',
  '心脏病',
  '中风',
  '脑卒中',
  '肥胖症',
  '低血糖症',
  '抑郁',
  '焦虑症',
] as const;

export type WordingCategory = 'banned_term' | 'presumed_disease';

export interface WordingIssue {
  category: WordingCategory;
  /** 命中的词（禁用词或疾病名称本身，不是客户资料） */
  term: string;
  /** 在被检查文本里的起点（UTF-16 码元） */
  index: number;
}

/** 找出疾病名称。先规范化（去空格、零宽字符，统一全角半角和繁简），位置按原文 */
export function findDiseaseTerms(text: string): { term: string; index: number }[] {
  const { text: normalized, origin } = normalizeForCompliance(text);
  const out: { term: string; index: number }[] = [];
  for (const term of DISEASE_TERMS) {
    for (let i = normalized.indexOf(term); i !== -1; i = normalized.indexOf(term, i + 1)) {
      out.push({ term, index: origin[i] ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 一段要对客户说的话：禁用词和疾病名称 */
export function checkSpokenWording(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...findDiseaseTerms(text).map((d) => ({ category: 'presumed_disease' as const, ...d })),
  ];
}

/** 只要类别（去重），用于重新生成时的提示和日志 */
export function wordingCategories(issues: readonly WordingIssue[]): WordingCategory[] {
  return [...new Set(issues.map((i) => i.category))];
}
