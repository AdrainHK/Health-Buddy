/**
 * 单位换算表（M2 规格 2.3、Q11）。
 *
 * 报告上的单位和指标目录不同时（如美国报告的血糖用 mg/dL），按这里的固定系数换算成目录单位，
 * 原值和原单位另外保留。只放确定的换算关系；表里没有的单位不换算，由健管师核对。
 */
import { REPORT_INDICATORS, type ReportIndicatorCode } from './catalog.js';

/** 单位写法的规范化：全角转半角、去空格、µ/μ 统一成 u、上标 2 统一成 2，再按别名表归一 */
const UNIT_ALIASES: Record<string, string> = {
  'mmol/l': 'mmol/L',
  'umol/l': 'umol/L',
  'mg/dl': 'mg/dL',
  'mmol/mol': 'mmol/mol',
  'u/l': 'U/L',
  'iu/l': 'U/L',
  'kg/m2': 'kg/m2',
  'kg/m^2': 'kg/m2',
  mmhg: 'mmHg',
  kpa: 'kPa',
  cm: 'cm',
  厘米: 'cm',
  m: 'm',
  米: 'm',
  in: 'in',
  inch: 'in',
  inches: 'in',
  英寸: 'in',
  kg: 'kg',
  公斤: 'kg',
  千克: 'kg',
  lb: 'lb',
  lbs: 'lb',
  磅: 'lb',
  '%': '%',
};

export function normalizeUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/²/g, '2')
    .toLowerCase();
  if (!key) return null;
  return UNIT_ALIASES[key] ?? null;
}

interface Conversion {
  /** 目录单位 = 原值 × scale + offset */
  scale: number;
  offset?: number;
}

/**
 * 换算系数：从某单位到目录单位。来源：
 * - 血糖 mg/dL × 0.0555 → mmol/L（葡萄糖分子量 180.16）
 * - 总胆固醇、LDL-C、HDL-C mg/dL × 0.02586 → mmol/L（胆固醇分子量 386.65）
 * - 甘油三酯 mg/dL × 0.01129 → mmol/L（按三油酸甘油酯 885.7）
 * - 肌酐 mg/dL × 88.42 → umol/L；尿酸 mg/dL × 59.48 → umol/L
 * - HbA1c：NGSP % = IFCC mmol/mol × 0.09148 + 2.152
 * - 血压 kPa × 7.50062 → mmHg；长度、重量按国际单位定义
 */
export const UNIT_CONVERSIONS: Partial<Record<ReportIndicatorCode, Record<string, Conversion>>> = {
  height: { m: { scale: 100 }, in: { scale: 2.54 } },
  weight: { lb: { scale: 0.45359237 } },
  waist: { m: { scale: 100 }, in: { scale: 2.54 } },
  sbp: { kPa: { scale: 7.50062 } },
  dbp: { kPa: { scale: 7.50062 } },
  fpg: { 'mg/dL': { scale: 0.0555 } },
  hba1c: { 'mmol/mol': { scale: 0.09148, offset: 2.152 } },
  tc: { 'mg/dL': { scale: 0.02586 } },
  ldl_c: { 'mg/dL': { scale: 0.02586 } },
  hdl_c: { 'mg/dL': { scale: 0.02586 } },
  tg: { 'mg/dL': { scale: 0.01129 } },
  creatinine: { 'mg/dL': { scale: 88.42 } },
  uric_acid: { 'mg/dL': { scale: 59.48 } },
};

export function catalogUnit(code: ReportIndicatorCode): string {
  return REPORT_INDICATORS.find((i) => i.code === code)?.unit ?? '';
}

/** 数值列是 numeric(12,3)，换算结果保留 3 位小数 */
export function roundValue(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type UnitConversion =
  | { status: 'same'; unit: string; convert: (n: number) => number }
  | { status: 'converted'; unit: string; convert: (n: number) => number }
  /** 单位缺失或换算表里没有：不换算，请健管师核对 */
  | { status: 'unknown' };

/** 找出把某单位换成目录单位的方法 */
export function unitConversion(code: ReportIndicatorCode, rawUnit: string | null): UnitConversion {
  const target = catalogUnit(code);
  const unit = normalizeUnit(rawUnit);
  if (unit === null) return { status: 'unknown' };
  if (unit === target) return { status: 'same', unit: target, convert: (n) => n };
  const c = UNIT_CONVERSIONS[code]?.[unit];
  if (!c) return { status: 'unknown' };
  return {
    status: 'converted',
    unit: target,
    convert: (n) => roundValue(n * c.scale + (c.offset ?? 0)),
  };
}

/**
 * 把报告上的数值文字解析成数字。带 <、> 等符号、带逗号（千分位还是小数点分不清）
 * 或不是数字时返回 null，不猜。
 */
export function parseNumericValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.normalize('NFKC').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
