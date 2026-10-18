/**
 * 每份专家意见的确定性校验（M3 规格 3.4），在后端执行，不依赖模型自觉：
 * 1. 结构（网关 completeStructured 已按 zod 校验）
 * 2. 引用：只能引用这位专家当前版本、当前环境允许的条目卡片
 * 3. 数值：阈值、界值、参考范围只能来自输入资料或被引用卡片的“可引用数值”
 * 4. 措辞：不出现禁用词和诊断性表述
 *
 * 结果只有问题类别和数量，不带原文，日志和纠正说明都只用类别（规格 3.4 第 5 条）。
 */
import {
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
] as const;
export type OpinionIssue = (typeof OPINION_ISSUES)[number];

/**
 * 诊断性表述和疗效承诺（规格 4.3–4.8 的禁止事项、7.1）。禁用词表（packages/shared/compliance）之外，
 * 专家意见还不能写这些说法；需要医生评估时写进 referral。
 */
// 不收“得了”：“还得了解”会误报
export const DIAGNOSTIC_PHRASES = ['确诊', '患有', '患上', '治好', '可以逆转', '能逆转'] as const;

/** 没有卡片支撑的要点不能写“根据指南”之类的话（规格 5.2 第 3 条） */
const GUIDELINE_CLAIM = /指南|共识|根据来源|按照来源|根据文献|研究表明/;

const DATE = /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/g;
const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * 文本里需要核对的数值：带小数的数字和 40 到 1900 之间的整数（血压、尿酸、步数、分钟数等）。
 * 日期、序号、天数这类小整数不核对，和评测的 inventedNumbers 规则一致（scripts/eval）。
 */
export function checkedNumbers(text: string): number[] {
  const withoutDates = text.replace(DATE, ' ');
  // 按原文判断是不是小数：“8.0”也要核对
  return (withoutDates.match(NUMBER) ?? [])
    .filter((raw) => raw.includes('.') || Number(raw) >= 40)
    .map(Number)
    .filter((n) => n < 1900);
}

/** 不在允许范围里的数值 */
export function unknownNumbers(text: string, allowed: Iterable<number>): number[] {
  const list = [...allowed];
  return checkedNumbers(text).filter((n) => !list.some((k) => Math.abs(k - n) < 1e-9));
}

/** 禁用词和诊断性表述（先规范化：去空格、零宽字符，统一全角半角和繁简） */
export function hasBannedWording(text: string): boolean {
  if (findBannedTerms(text).length) return true;
  const norm = normalizeForCompliance(text).text;
  return DIAGNOSTIC_PHRASES.some((p) => norm.includes(p));
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
  const validCitation = (c: Citation): CitableCard | undefined => {
    const card = cards.get(c.cardId);
    return card && card.sourceId === c.sourceId ? card : undefined;
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

  // 结论可以复述被保留的要点里引用的卡片数值
  const keptCitations = [...findings, ...suggestions].flatMap((i) => i.citations);
  const summaryOk = itemOk({ texts: [opinion.summary], citations: keptCitations });
  if (!summaryOk || !opinion.summary.trim()) {
    return { opinion: null, issues: [...issues], removed, fatal: true };
  }

  // 转介的方向和原因不合格时只去掉文字，needed 和 urgency 一定保留（转介一条都不能丢）
  const referral = normalizeReferral(opinion.referral);
  if (referral.to && !itemOk({ texts: [referral.to], citations: [] })) referral.to = null;
  if (referral.reason && !itemOk({ texts: [referral.reason], citations: keptCitations }))
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
    '有引用不在你的条目卡片清单里，或标为 cited 的要点没有引用。只能引用清单里列出的卡片编号；没有卡片支撑的要点标 data_only。',
  invented_number:
    '有数值既不在客户资料里，也不在被引用卡片的“可引用数值”里。删掉这些数值，不要凭常识写阈值、界值或目标值。',
  banned_wording:
    '出现了禁用词或诊断性表述（如“确诊”“患有”“治好”）。改成描述数据，需要医生评估的写进 referral。',
  unsupported_claim: '标为 data_only 的要点写了“根据指南”之类的话。没有卡片支撑时只描述数据。',
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
