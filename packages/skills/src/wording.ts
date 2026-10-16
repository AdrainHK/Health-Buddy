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

/** 具体药名和药物类别。问题里只能问“在用哪些药”，不能点名药物 */
export const DRUG_NAMES = [
  '降压药',
  '降糖药',
  '他汀',
  '二甲双胍',
  '胰岛素',
  '阿司匹林',
  '氨氯地平',
  '非布司他',
  '别嘌醇',
] as const;

/** 同一个分句里的字（规范化后全角标点已变成半角，两种都排除） */
const SAME_CLAUSE = '[^，。；：！？,.;:!?\\n]';

/**
 * 用药建议的句式（在规范化后的文本上匹配）：
 * - “建议”后面跟着服用、停药、停用、加量、减量；
 * - “建议”后面跟着吃药、用药（“建议少吃甜食”“建议把白米饭换成杂粮饭”是饮食建议，不算）；
 * - 换成、改用、加用某个具体药物。
 * 只在同一个分句里匹配：“未按要求给出用药建议，原因：用药调整需由医生评估”不算。
 * 问用药情况的问题（“最近有没有停过药？”）不算建议。
 */
export const DRUG_ADVICE = new RegExp(
  [
    `建议${SAME_CLAUSE}{0,6}(?:服用|停药|停用|加量|减量)`,
    `建议${SAME_CLAUSE}{0,6}(?:吃|用)${SAME_CLAUSE}{0,2}药`,
    `(?:换成|换用|改用|改吃|加用)${SAME_CLAUSE}{0,6}(?:${DRUG_NAMES.join('|')})`,
  ].join('|'),
);

/** 剂量（数字 + 剂量单位） */
export const DOSE = /\d+(?:\.\d+)?\s*(?:mg|毫克|片|粒|单位|IU)/i;

export type WordingCategory = 'banned_term' | 'presumed_disease' | 'drug_name' | 'drug_advice';

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

/** 找出具体药名（先规范化），位置按原文 */
export function findDrugNames(text: string): { term: string; index: number }[] {
  const { text: normalized, origin } = normalizeForCompliance(text);
  const out: { term: string; index: number }[] = [];
  for (const term of DRUG_NAMES) {
    for (let i = normalized.indexOf(term); i !== -1; i = normalized.indexOf(term, i + 1)) {
      out.push({ term, index: origin[i] ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * 用药建议或剂量（规格 2.8：提纲不给用药建议）。在规范化后的文本上匹配；
 * term 只写“用药建议”“剂量”这类类别名，不带原文。
 */
export function findDrugAdvice(text: string): WordingIssue[] {
  const { text: normalized, origin } = normalizeForCompliance(text);
  const out: WordingIssue[] = [];
  const advice = DRUG_ADVICE.exec(normalized);
  if (advice)
    out.push({ category: 'drug_advice', term: '用药建议', index: origin[advice.index] ?? 0 });
  const dose = DOSE.exec(normalized);
  if (dose) out.push({ category: 'drug_advice', term: '剂量', index: origin[dose.index] ?? 0 });
  return out;
}

/** 一段要对客户说的话：禁用词、疾病名称、具体药名和用药建议 */
export function checkSpokenWording(text: string): WordingIssue[] {
  return [
    ...findBannedTerms(text).map((b) => ({
      category: 'banned_term' as const,
      term: b.term,
      index: b.index,
    })),
    ...findDiseaseTerms(text).map((d) => ({ category: 'presumed_disease' as const, ...d })),
    ...findDrugNames(text).map((d) => ({ category: 'drug_name' as const, ...d })),
    ...findDrugAdvice(text),
  ];
}

/** 只要类别（去重），用于重新生成时的提示和日志 */
export function wordingCategories(issues: readonly WordingIssue[]): WordingCategory[] {
  return [...new Set(issues.map((i) => i.category))];
}
