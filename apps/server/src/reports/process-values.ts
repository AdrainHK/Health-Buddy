import {
  mapIndicatorName,
  parseNumericValue,
  parseReferenceRange,
  REPORT_INDICATORS,
  THRESHOLD_BOUNDS,
  unitConversion,
  type ExtractedValueFlag,
  type ReportIndicatorCode,
} from '@health-buddy/shared';

/**
 * 识别结果的确定性处理（M2 规格 2.3 第 6 条），不交给模型：
 * 名称对应指标目录编码（对不上的标为未收录，Q10）；单位按固定换算表换算，原值和原单位保留（Q11）；
 * 超出合理范围的标为请重点核对；读不出数字的标为看不清。
 */

/** 模型转录的一行，或健管师修改、补录的一行 */
export interface RawItem {
  rawName: string;
  rawValue: string;
  rawUnit: string | null;
  refText: string | null;
  page: number | null;
  snippet: string | null;
  unreadable: boolean;
}

export interface ProcessedItem extends RawItem {
  code: ReportIndicatorCode | null;
  value: number | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  flags: ExtractedValueFlag[];
}

const CATALOG_CODES = new Set<string>(REPORT_INDICATORS.map((i) => i.code));

export function isCatalogCode(code: string): code is ReportIndicatorCode {
  return CATALOG_CODES.has(code);
}

/**
 * 处理一行。code 不传时按名称对应；传 null 表示健管师选择作为未收录指标保存；
 * 传编码表示健管师指定了指标。
 */
export function processItem(item: RawItem, code?: ReportIndicatorCode | null): ProcessedItem {
  const resolved = code === undefined ? mapIndicatorName(item.rawName) : code;
  const flags = new Set<ExtractedValueFlag>();
  if (item.unreadable) flags.add('unreadable');
  const numeric = parseNumericValue(item.rawValue);
  const range = parseReferenceRange(item.refText);

  if (resolved === null) {
    // 未收录指标：照原样保存原始名称、数值、单位和参考范围，不换算
    flags.add('unmapped');
    return {
      ...item,
      code: null,
      value: numeric,
      unit: item.rawUnit,
      refLow: range?.low ?? null,
      refHigh: range?.high ?? null,
      flags: [...flags],
    };
  }

  const conversion = unitConversion(resolved, item.rawUnit);
  if (conversion.status === 'unknown') {
    // 单位缺失或不认识：不换算，请健管师核对（Q11）
    flags.add('unit_unknown');
    if (numeric === null) flags.add('unreadable');
    return {
      ...item,
      code: resolved,
      value: null,
      unit: null,
      refLow: null,
      refHigh: null,
      flags: [...flags],
    };
  }
  if (conversion.status === 'converted') flags.add('unit_converted');
  if (numeric === null) flags.add('unreadable');
  const value = numeric === null ? null : conversion.convert(numeric);
  if (value !== null) {
    const bounds = THRESHOLD_BOUNDS[resolved];
    if (value < bounds.min || value > bounds.max) flags.add('out_of_bounds');
  }
  return {
    ...item,
    code: resolved,
    value,
    unit: conversion.unit,
    refLow: range?.low == null ? null : conversion.convert(range.low),
    refHigh: range?.high == null ? null : conversion.convert(range.high),
    flags: [...flags],
  };
}

/** 已有的正式报告里，同一报告日期的当前值（按指标编码） */
export type SameDateValues = Map<string, number[]>;

const SAME = 0.0005;

/**
 * 和已有记录对比（Q17）：同一报告日期已有同一指标时，数值相同标为可能重复，不同标为冲突。
 * 同一次上传里同一指标出现多行时，后面的行也标为冲突，由健管师删掉多余的一行。
 */
export function markConflicts(items: ProcessedItem[], existing: SameDateValues): ProcessedItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (!item.code) return item;
    const flags = new Set(item.flags);
    flags.delete('conflict');
    flags.delete('duplicate');
    if (seen.has(item.code)) flags.add('conflict');
    seen.add(item.code);
    const others = existing.get(item.code) ?? [];
    if (others.length && item.value !== null) {
      const value = item.value;
      if (others.some((v) => Math.abs(v - value) < SAME)) flags.add('duplicate');
      else flags.add('conflict');
    } else if (others.length) {
      flags.add('conflict');
    }
    return { ...item, flags: [...flags] };
  });
}
