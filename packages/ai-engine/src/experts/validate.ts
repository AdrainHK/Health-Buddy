/**
 * 每份专家意见的确定性校验（M3 规格 3.4），在后端执行，不依赖模型自觉：
 * 1. 结构（网关 completeStructured 已按 zod 校验）
 * 2. 引用：只能引用这位专家当前版本、当前环境允许的、使用范围为 advice 的条目卡片
 * 3. 数值：阈值、界值、参考范围只能来自输入资料或被引用卡片的“可引用数值”
 * 4. 措辞：不出现禁用词和诊断性表述
 *
 * 结果只有问题类别和数量，不带原文，日志和纠正说明都只用类别（规格 3.4 第 5 条）。
 */
import {
  DRUG_NAMES,
  findBannedTerms,
  normalizeForCompliance,
  type Citation,
  type ExpertOpinion,
} from '@health-buddy/shared';
import type { CitableCard, ExpertProfile } from './types.js';

export const OPINION_ISSUES = [
  'bad_citation',
  'invented_number',
  'banned_wording',
  'unsupported_claim',
  'scope_inconsistent',
  'drug_advice',
] as const;
export type OpinionIssue = (typeof OPINION_ISSUES)[number];

/**
 * 诊断性表述和疗效承诺（规格 4.3–4.8 的禁止事项、7.1）。禁用词表（packages/shared/compliance）之外，
 * 专家意见还不能写这些说法；需要医生评估时写进 referral。
 */
// 不收“得了”：“还得了解”会误报
export const DIAGNOSTIC_PHRASES = ['确诊', '患有', '患上', '治好', '可以逆转', '能逆转'] as const;

/** 诊断性句式（合规审查补充）：“属于糖尿病前期”“考虑为”“诊为”“已经是高血压病”“提示脂肪肝” */
export const DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  /属于[^，。；,;]{0,8}(?:病|前期|症)/,
  /考虑为/,
  /诊为/,
  /已经是[^，。；,;]{0,8}(?:病|症)/,
  /提示[^，。；,;]{0,8}(?:病|肝|症)/,
];

/** 文本里的诊断性表述（先规范化），返回命中的词或句式片段 */
export function diagnosticHits(text: string): string[] {
  const norm = normalizeForCompliance(text).text;
  return [
    ...DIAGNOSTIC_PHRASES.filter((p) => norm.includes(p)),
    ...DIAGNOSTIC_PATTERNS.flatMap((re) => re.exec(norm)?.[0] ?? []),
  ];
}

/**
 * 药物剂量（合规审查补充）：数字加药物剂量单位（5 mg、10 单位、2 片），中文数字加毫克、微克、粒、胶囊，
 * 或“每次两片”。检验单位（mg/dL、µmol/L、U/L）后面紧跟 / 或字母，不算剂量；饮水的毫升数不算。
 */
const DRUG_DOSE =
  /\d+(?:\.\d+)?\s*(?:mg|毫克|µg|μg|ug|mcg|微克|片|粒|胶囊|单位|IU)(?![/A-Za-z])|[一二两三四五六七八九十半]+(?:毫克|微克|粒|胶囊)|每次[一二两三半]+片/i;

/** 具体药名（不含“降压药”这类类别词：了解客户在用哪类药是健管师的正常工作） */
const SPECIFIC_DRUGS = DRUG_NAMES.filter((d) => !d.endsWith('药'));

/** 点名具体药物或写了剂量、服用频次 */
export function hasDrugAdvice(text: string): boolean {
  const norm = normalizeForCompliance(text).text;
  return DRUG_DOSE.test(norm) || SPECIFIC_DRUGS.some((d) => norm.includes(d));
}
/** 没有卡片支撑的要点不能写“根据指南”之类的话（规格 5.2 第 3 条） */
const GUIDELINE_CLAIM = /指南|共识|根据来源|按照来源|根据文献|研究表明/;

const DATE = /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g;

/** 检验和测量单位：数字后面跟这些单位时，不论大小都要核对 */
const UNIT =
  '(?:mmol\\/L|μmol\\/L|µmol\\/L|umol\\/L|mg\\/dL|mg\\/L|g\\/L|U\\/L|IU\\/L|mmHg|kg\\/m²|kg\\/m2|次\\/分|bpm|kcal|千卡|kg|公斤|cm|厘米|%|％)';
/** 阈值、目标的说法：紧挨着这些词的数字不论大小都要核对 */
const THRESHOLD_BEFORE = '(?:超过|低于|高于|大于|小于|不超过|不低于|控制在|目标|达到|≥|≤|>|<)';
const THRESHOLD_AFTER = '(?:以上|以下|以内)';
const NUMBER_WITH_CONTEXT = new RegExp(
  `(${THRESHOLD_BEFORE})?\\s*(百分之)?(\\d+(?:\\.\\d+)?)\\s*(${UNIT}|${THRESHOLD_AFTER})?`,
  'g',
);

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字转阿拉伯数字：“六点五”→6.5，“一百四十”→140，“一百四”→140，“十二”→12；不认识时返回 null */
export function parseChineseNumber(raw: string): number | null {
  const [intPart = '', fracPart] = raw.split('点');
  let total = 0;
  let current = 0;
  let lastUnit = 1;
  for (const ch of intPart) {
    if (ch in CN_DIGIT) current = CN_DIGIT[ch]!;
    else if (ch === '十' || ch === '百' || ch === '千') {
      const unit = ch === '十' ? 10 : ch === '百' ? 100 : 1000;
      total += (current || 1) * unit;
      current = 0;
      lastUnit = unit;
    } else return null;
  }
  // “一百四”：最后一位省略了单位，按上一位单位的十分之一
  if (current && lastUnit >= 100 && !intPart.endsWith('零')) total += current * (lastUnit / 10);
  else total += current;
  if (fracPart === undefined) return total;
  let frac = '';
  for (const ch of fracPart) {
    if (!(ch in CN_DIGIT)) return null;
    frac += String(CN_DIGIT[ch]);
  }
  return frac ? Number(`${total}.${frac}`) : null;
}

const CN_NUMBER = /[零〇一二两三四五六七八九十百千]+(?:点[零〇一二三四五六七八九]+)?/g;

/**
 * 把会被当成数值的中文数字换成阿拉伯数字：带“点”的小数、“百分之…”，以及后面跟单位或前后有阈值说法的。
 * “一起”“每一项”这类不换。
 */
function normalizeChineseNumbers(text: string): string {
  return text.replace(CN_NUMBER, (raw, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 4), offset);
    const after = whole.slice(offset + raw.length, offset + raw.length + 8);
    const decimal = raw.includes('点');
    const percent = before.endsWith('百分之');
    const unit = new RegExp(`^\\s*(?:${UNIT}|${THRESHOLD_AFTER})`).test(after);
    const threshold = new RegExp(`${THRESHOLD_BEFORE}\\s*$`).test(before);
    if (!decimal && !percent && !unit && !threshold) return raw;
    const n = parseChineseNumber(raw);
    return n === null ? raw : String(n);
  });
}

/**
 * 文本里需要核对的数值：
 * - 带小数的数字和 40 到 1900 之间的整数（血压、尿酸、步数、分钟数等）；
 * - 后面跟检验或测量单位、百分号的数字，不论大小（“5%”“7 mmol/L”）；
 * - 紧挨着“超过”“低于”“控制在”“目标”“以上”“以下”这类阈值说法的数字，不论大小。
 * 中文数字先换成阿拉伯数字。日期、序号、天数这类小整数不核对；评测的规则检查用同一个函数（scripts/eval）。
 */
export function checkedNumbers(text: string): number[] {
  const prepared = normalizeChineseNumbers(text.replace(DATE, ' '));
  const out: number[] = [];
  for (const m of prepared.matchAll(NUMBER_WITH_CONTEXT)) {
    const [, threshold, percent, raw = '', suffix] = m;
    const n = Number(raw);
    const contextual = Boolean(threshold || percent || suffix);
    // 按原文判断是不是小数：“8.0”也要核对
    if (contextual || raw.includes('.') || (n >= 40 && n < 1900)) out.push(n);
  }
  return out;
}

/** 不在允许范围里的数值 */
export function unknownNumbers(text: string, allowed: Iterable<number>): number[] {
  const list = [...allowed];
  return checkedNumbers(text).filter((n) => !list.some((k) => Math.abs(k - n) < 1e-9));
}

/** 禁用词和诊断性表述（先规范化：去空格、零宽字符，统一全角半角和繁简） */
export function hasBannedWording(text: string): boolean {
  return findBannedTerms(text).length > 0 || diagnosticHits(text).length > 0;
}

export interface OpinionCheck {
  /** 去掉不合格要点后的意见；fatal 时为空 */
  opinion: ExpertOpinion | null;
  issues: OpinionIssue[];
  /** 移除的要点数（要点、建议、要了解的情况、缺少的数据） */
  removed: number;
  /** 整份不可用：结论、超出范围说明不合格，或范围标记自相矛盾 */
  fatal: boolean;
}

interface Item {
  texts: string[];
  citations: Citation[];
  /** data_only 的要点不能声称依据指南 */
  dataOnly?: boolean;
  /** cited 的要点必须至少有一条有效引用 */
  needsCitation?: boolean;
}

export function validateOpinion(
  opinion: ExpertOpinion,
  profile: Pick<ExpertProfile, 'cards'>,
  allowedNumbers: readonly number[],
): OpinionCheck {
  const issues = new Set<OpinionIssue>();
  const cards = new Map(profile.cards.map((c) => [c.cardId, c]));
  // 只能引用 advice 范围的卡片：referral_only 的来源（诊断、治疗、用药、操作、急救类）
  // 只用来识别什么时候该转介，不能作为要点和建议的依据（规格 5.1、5.2 第 1 条）
  const validCitation = (c: Citation): CitableCard | undefined => {
    const card = cards.get(c.cardId);
    return card && card.sourceId === c.sourceId && card.scope === 'advice' ? card : undefined;
  };

  /** 检查一条要点，返回是否合格；问题类别记进 issues */
  const itemOk = (item: Item): boolean => {
    let ok = true;
    const cited = item.citations.map(validCitation);
    if (cited.some((c) => !c) || (item.needsCitation && !item.citations.length)) {
      issues.add('bad_citation');
      ok = false;
    }
    const allowed = [...allowedNumbers, ...cited.flatMap((c) => (c ? [...c.numbers] : []))];
    const text = item.texts.join('\n');
    if (unknownNumbers(text, allowed).length) {
      issues.add('invented_number');
      ok = false;
    }
    if (hasBannedWording(text)) {
      issues.add('banned_wording');
      ok = false;
    }
    if (hasDrugAdvice(text)) {
      issues.add('drug_advice');
      ok = false;
    }
    if (item.dataOnly && GUIDELINE_CLAIM.test(normalizeForCompliance(text).text)) {
      issues.add('unsupported_claim');
      ok = false;
    }
    return ok;
  };

  // 超出范围：只填说明，其余为空（规格 4.2）
  if (!opinion.inScope) {
    const note = opinion.outOfScopeNote?.trim() ?? '';
    if (!note) {
      issues.add('scope_inconsistent');
      return { opinion: null, issues: [...issues], removed: 0, fatal: true };
    }
    const ok = itemOk({ texts: [note, opinion.summary], citations: [] });
    if (!ok) return { opinion: null, issues: [...issues], removed: 0, fatal: true };
    return {
      opinion: {
        ...opinion,
        findings: [],
        suggestions: [],
        questionsToAsk: [],
        dataGaps: [],
        referral: normalizeReferral(opinion.referral),
      },
      issues: [...issues],
      removed: 0,
      fatal: false,
    };
  }

  let removed = 0;
  const keep = <T>(list: T[], toItem: (t: T) => Item): T[] =>
    list.filter((t) => {
      const ok = itemOk(toItem(t));
      if (!ok) removed++;
      return ok;
    });

  const findings = keep(opinion.findings, (f) => ({
    texts: [f.point, ...f.dataRefs.flatMap((d) => [d.label, d.value ?? ''])],
    citations: f.citations,
    dataOnly: f.basis === 'data_only',
    needsCitation: f.basis === 'cited',
  }));
  const suggestions = keep(opinion.suggestions, (s) => ({
    texts: [s.text],
    citations: s.citations,
    dataOnly: !s.citations.length,
  }));
  const questionsToAsk = keep(opinion.questionsToAsk, (q) => ({ texts: [q], citations: [] }));
  const dataGaps = keep(opinion.dataGaps, (d) => ({ texts: [d], citations: [] }));

  // 结论可以复述被保留的要点里引用的卡片数值；保留的要点里没有一条有效引用时，
  // 结论和转介原因同样不能写“根据指南”
  const keptCitations = [...findings, ...suggestions].flatMap((i) => i.citations);
  const noCitation = !keptCitations.length;
  const summaryOk = itemOk({
    texts: [opinion.summary],
    citations: keptCitations,
    dataOnly: noCitation,
  });
  if (!summaryOk || !opinion.summary.trim()) {
    return { opinion: null, issues: [...issues], removed, fatal: true };
  }

  // 转介的方向和原因不合格时只去掉文字，needed 和 urgency 一定保留（转介一条都不能丢）
  const referral = normalizeReferral(opinion.referral);
  if (referral.to && !itemOk({ texts: [referral.to], citations: [] })) referral.to = null;
  if (
    referral.reason &&
    !itemOk({ texts: [referral.reason], citations: keptCitations, dataOnly: noCitation })
  )
    referral.reason = null;

  return {
    opinion: {
      ...opinion,
      outOfScopeNote: null,
      findings,
      suggestions,
      questionsToAsk,
      dataGaps,
      referral,
    },
    issues: [...issues],
    removed,
    fatal: false,
  };
}

/** needed 为 false 时其余为空；需要转介但没给级别时按“建议就医评估” */
function normalizeReferral(r: ExpertOpinion['referral']): ExpertOpinion['referral'] {
  if (!r.needed) return { needed: false, urgency: null, to: null, reason: null };
  return {
    needed: true,
    urgency: r.urgency ?? 'attention',
    to: r.to?.trim() || null,
    reason: r.reason?.trim() || null,
  };
}

const ISSUE_NOTES: Record<OpinionIssue, string> = {
  bad_citation:
    '有引用不在你的条目卡片清单里、引用了“只用于判断是否需要转介的卡片”，或标为 cited 的要点没有引用。只能引用“可以引用的条目卡片”里列出的卡片编号；没有卡片支撑的要点标 data_only。',
  invented_number:
    '有数值既不在客户资料里，也不在被引用卡片的“可引用数值”里。删掉这些数值，不要凭常识写阈值、界值或目标值。',
  banned_wording:
    '出现了禁用词或诊断性表述（如“确诊”“患有”“治好”）。改成描述数据，需要医生评估的写进 referral。',
  unsupported_claim:
    '没有卡片支撑的内容（data_only 的要点，或没有任何有效引用时的结论和转介原因）写了“根据指南”之类的话。没有卡片支撑时只描述数据。',
  drug_advice:
    '点名了具体药物，或写了剂量、服用频次。不推荐、不评价药物和剂量，需要调整用药的写进 referral。',
  scope_inconsistent:
    'inScope 为 false 时必须在 outOfScopeNote 里写明建议改问哪位专家或转介哪类医生。',
};

/** 重试时附在用户消息后面的纠正说明：只按问题类别写，不复述上次的输出 */
export function correctionNote(issues: readonly OpinionIssue[]): string {
  return [
    '## 上一次输出没有通过检查，请重新输出完整的意见',
    ...issues.map((i) => `- ${ISSUE_NOTES[i]}`),
  ].join('\n');
}
