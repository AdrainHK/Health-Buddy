/**
 * 按报告上印的参考范围判断高低（M2 规格 2.5 第 3 条、Q10）。
 *
 * 只用报告上印的范围，不用指标目录里的默认范围；没有范围时是 no_reference。
 * 范围两端默认包含在内（3.9–6.1 时 6.1 算正常）；报告印的是“<1.7”这类严格不等号时，
 * 等于界值算超出（1.7 算偏高），“≤1.7”时算正常。
 */

export const ABNORMAL_FLAGS = ['high', 'low', 'normal', 'no_reference'] as const;
export type AbnormalFlag = (typeof ABNORMAL_FLAGS)[number];

export interface ReferenceRange {
  low: number | null;
  high: number | null;
  /** 下限是否包含在正常范围内（“>1.0”时为 false） */
  lowInclusive: boolean;
  /** 上限是否包含在正常范围内（“<1.7”时为 false） */
  highInclusive: boolean;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
/** 范围数字后面印的单位（如 %、mmol/L、×10^9/L、MFI），不以数字开头 */
const UNIT = String.raw`[a-zμµ%×*/][a-z0-9μµ%×*/^.]*`;

/**
 * 解析报告上印的参考范围文字。认得这几种写法：
 * “3.9-6.1”“3.9～6.1”“3.9 — 6.1”“3.9 至 6.1”“<1.7”“≤5.2”“>1.0”“≥1.04”“1.0 以上”“5.2 以下”，
 * 外面包着括号、后面或两端都跟着单位（“(0-15)”“0-15 μmol/L”“2.0%-10.0%”）也认得。
 * 认不出时返回 null（不猜），健管师可以在核对时手动填写。
 */
export function parseReferenceRange(text: string | null | undefined): ReferenceRange | null {
  if (!text) return null;
  const t = text
    .normalize('NFKC')
    .replace(/\s+/g, '')
    // 整段包在括号里：“(0-15)”“[3.9-6.1]”
    .replace(/^[([【（]+|[)\]】）]+$/g, '')
    .replace(/[～〜~—–－‐‑‒―−至到]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[≤⩽]/g, '<=')
    .replace(/[≥⩾]/g, '>=');
  // 两端都可以带同一个单位：“2.0%-10.0%”“0.1%-1.0%”“3.9mmol/L-6.1mmol/L”；只有一端带也行
  const m = new RegExp(`^${NUM}(${UNIT})?-${NUM}(${UNIT})?$`, 'i').exec(t);
  if (m) {
    const low = Number(m[1]);
    const high = Number(m[3]);
    const [lowUnit, highUnit] = [m[2], m[4]];
    if (lowUnit && highUnit && lowUnit.toLowerCase() !== highUnit.toLowerCase()) return null;
    if (low > high) return null;
    return { low, high, lowInclusive: true, highInclusive: true };
  }
  return parseOneSided(t.replace(new RegExp(`(\\d)${UNIT}$`, 'i'), '$1'));
}

/** 单侧界限：“<1.7”“≤5.2”“>1.0”“≥1.04”“1.0 以上”“5.2 以下”（后面的单位已去掉） */
function parseOneSided(t: string): ReferenceRange | null {
  let m: RegExpExecArray | null;
  m = new RegExp(`^(<=|<)${NUM}$`).exec(t);
  if (m) return { low: null, high: Number(m[2]), lowInclusive: true, highInclusive: m[1] === '<=' };
  m = new RegExp(`^(>=|>)${NUM}$`).exec(t);
  if (m) return { low: Number(m[2]), high: null, lowInclusive: m[1] === '>=', highInclusive: true };
  m = new RegExp(`^${NUM}以下$`).exec(t);
  if (m) return { low: null, high: Number(m[1]), lowInclusive: true, highInclusive: true };
  m = new RegExp(`^${NUM}以上$`).exec(t);
  if (m) return { low: Number(m[1]), high: null, lowInclusive: true, highInclusive: true };
  return null;
}

/** 健管师手动填写的范围：两端都包含在内 */
export function inclusiveRange(low: number | null, high: number | null): ReferenceRange | null {
  if (low === null && high === null) return null;
  return { low, high, lowInclusive: true, highInclusive: true };
}

/** 数值和参考范围比较，得出高低标记 */
export function classifyAgainstReference(
  value: number | null,
  range: ReferenceRange | null,
): AbnormalFlag {
  if (value === null || !range || (range.low === null && range.high === null)) {
    return 'no_reference';
  }
  if (range.high !== null) {
    if (range.highInclusive ? value > range.high : value >= range.high) return 'high';
  }
  if (range.low !== null) {
    if (range.lowInclusive ? value < range.low : value <= range.low) return 'low';
  }
  return 'normal';
}

/**
 * 按存库的列判断：ref_low、ref_high 是数值（已换算成和数值相同的单位），
 * ref_text 是报告上印的原文，只用来判断界值是否包含在内。
 */
export function abnormalFromColumns(
  value: number | null,
  refLow: number | null,
  refHigh: number | null,
  refText: string | null,
): AbnormalFlag {
  const parsed = parseReferenceRange(refText);
  const range = inclusiveRange(refLow, refHigh);
  if (!range) return 'no_reference';
  if (parsed) {
    range.lowInclusive = parsed.low === null ? true : parsed.lowInclusive;
    range.highInclusive = parsed.high === null ? true : parsed.highInclusive;
  }
  return classifyAgainstReference(value, range);
}
