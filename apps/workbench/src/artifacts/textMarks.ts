import {
  findBannedTerms,
  normalizeForCompliance,
  type ClientTextHints,
} from '@health-buddy/shared';

/**
 * 通俗版里要标出的位置。下标按 UTF-16 码元，和后端一致。
 * - banned：禁用词，确认被拦截；
 * - critical：危急指标数值，确认被拦截；
 * - judgement：疾病名称、判断句式，只提示不拦截。
 */
export type MarkKind = 'banned' | 'critical' | 'judgement';

export interface TextMark {
  kind: MarkKind;
  start: number;
  end: number;
  /** 禁用词本身、危急指标编码或提示的原文片段 */
  label: string;
}

/**
 * 禁用词在原文里的范围。findBannedTerms 只给起点；
 * 词中间可能插了空格或零宽字符，所以从起点开始规范化，按映射找到终点。
 */
export function bannedTermMarks(text: string): TextMark[] {
  return findBannedTerms(text).map(({ term, index }) => ({
    kind: 'banned',
    start: index,
    end: endOfNormalized(text, index, term.length),
    label: term,
  }));
}

/** 后端 409 返回的禁用词位置（只有起点和词），按同样方式算出终点 */
export function serverBannedMarks(
  text: string,
  terms: readonly { term: string; index: number }[],
): TextMark[] {
  return terms
    .filter((t) => t.index >= 0 && t.index < text.length)
    .map(({ term, index }) => ({
      kind: 'banned',
      start: index,
      end: endOfNormalized(text, index, term.length),
      label: term,
    }));
}

function endOfNormalized(text: string, start: number, normLength: number): number {
  const { origin } = normalizeForCompliance(text.slice(start));
  const last = origin[normLength - 1];
  if (last === undefined) return Math.min(text.length, start + normLength);
  // origin 指向字符起点；代理对字符占两个码元
  const cp = text.codePointAt(start + last) ?? 0;
  return start + last + (cp > 0xffff ? 2 : 1);
}

/**
 * 危急指标数值的位置。后端只给起点，范围取从起点开始的数字（含小数点）；
 * 起点不是数字时只标一个字符。
 */
export function criticalMarks(
  text: string,
  mentions: readonly { metric: string; index: number }[],
): TextMark[] {
  return mentions
    .filter((m) => m.index >= 0 && m.index < text.length)
    .map(({ metric, index }) => {
      const digits = /^[0-9０-９]+(?:[.．][0-9０-９]+)?/.exec(text.slice(index));
      return {
        kind: 'critical',
        start: index,
        end: index + (digits ? digits[0].length : 1),
        label: metric,
      };
    });
}

/**
 * 判断句式提示。提示是按服务端保存的文本算的；本地改过文字后，
 * 在新文本里找离原位置最近的同一片段，找不到就不再标出。
 */
export function judgementMarks(
  text: string,
  hints: ClientTextHints['judgementHints'],
  sourceText: string,
): TextMark[] {
  const out: TextMark[] = [];
  for (const hint of hints) {
    if (!hint.text) continue;
    let start = -1;
    if (text === sourceText) {
      start = hint.index;
    } else {
      let best = Infinity;
      for (let i = text.indexOf(hint.text); i !== -1; i = text.indexOf(hint.text, i + 1)) {
        const distance = Math.abs(i - hint.index);
        if (distance < best) {
          best = distance;
          start = i;
        }
      }
    }
    if (start < 0 || start + hint.text.length > text.length) continue;
    out.push({ kind: 'judgement', start, end: start + hint.text.length, label: hint.text });
  }
  return out;
}

export interface Segment {
  text: string;
  mark?: TextMark;
}

/**
 * 把文本切成普通片段和标记片段。标记按起点排序，重叠时保留先出现的
 * （调用方把拦截类标记放在前面，优先显示）。
 */
export function segmentText(text: string, marks: readonly TextMark[]): Segment[] {
  const priority: Record<MarkKind, number> = { banned: 0, critical: 1, judgement: 2 };
  const sorted = [...marks]
    .filter((m) => m.end > m.start && m.start >= 0 && m.end <= text.length)
    .sort((a, b) => a.start - b.start || priority[a.kind] - priority[b.kind]);
  const out: Segment[] = [];
  let pos = 0;
  for (const mark of sorted) {
    if (mark.start < pos) continue;
    if (mark.start > pos) out.push({ text: text.slice(pos, mark.start) });
    out.push({ text: text.slice(mark.start, mark.end), mark });
    pos = mark.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}
