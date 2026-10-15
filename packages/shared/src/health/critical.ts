/**
 * 危急指标阈值（M1 规格第五节之二）。
 *
 * 阈值是医学判断，由运营人员在后台审定。这里只放默认值和合理范围：
 * 默认值参照国际通用标准，合理范围用来挡住明显的误填（比如把 180 写成 1800）。
 */
import type { CriticalFlag } from '../api/artifacts.js';
import { REPORT_INDICATORS, MONITORING_METRICS } from './catalog.js';

export const CRITICAL_COMPARATORS = ['gte', 'gt', 'lte', 'lt'] as const;
export type CriticalComparator = (typeof CRITICAL_COMPARATORS)[number];

/** urgent：需尽快就医；attention：建议就医评估 */
export const CRITICAL_LEVELS = ['urgent', 'attention'] as const;
export type CriticalLevel = (typeof CRITICAL_LEVELS)[number];

/** 指标目录里的全部编码（体检和监测去重） */
export const INDICATOR_CODES = [
  ...new Set([...REPORT_INDICATORS, ...MONITORING_METRICS].map((i) => i.code)),
] as const;
export type IndicatorCode =
  (typeof REPORT_INDICATORS)[number]['code'] | (typeof MONITORING_METRICS)[number]['code'];

export function indicatorUnit(code: IndicatorCode): string {
  const def = [...REPORT_INDICATORS, ...MONITORING_METRICS].find((i) => i.code === code);
  return def?.unit ?? '';
}

/** 阈值允许填写的范围（按指标目录的单位），超出视为误填。 */
export const THRESHOLD_BOUNDS: Record<IndicatorCode, { min: number; max: number }> = {
  height: { min: 50, max: 250 },
  weight: { min: 20, max: 300 },
  bmi: { min: 10, max: 70 },
  waist: { min: 30, max: 200 },
  sbp: { min: 50, max: 300 },
  dbp: { min: 30, max: 200 },
  fpg: { min: 1, max: 40 },
  hba1c: { min: 3, max: 20 },
  tc: { min: 1, max: 20 },
  tg: { min: 0.1, max: 50 },
  ldl_c: { min: 0.1, max: 15 },
  hdl_c: { min: 0.1, max: 5 },
  alt: { min: 1, max: 2000 },
  ast: { min: 1, max: 2000 },
  creatinine: { min: 10, max: 2000 },
  uric_acid: { min: 50, max: 1500 },
  heart_rate: { min: 20, max: 250 },
  steps: { min: 0, max: 100000 },
  sleep_hours: { min: 0, max: 24 },
};

export interface CriticalRule {
  metric: IndicatorCode;
  comparator: CriticalComparator;
  value: number;
  level: CriticalLevel;
}

/**
 * 平台默认阈值。参照：
 * - 血压：ACC/AHA 2017 高血压危象（≥180/≥120）；收缩压 <90 为低血压通用界值。
 * - 血糖：ADA 2 级低血糖（<3.0 mmol/L）；≥16.7 mmol/L（300 mg/dL）为常用紧急评估界值。
 * - 心率、尿酸：没有国际公认的危急标准，取常用做法，须运营人员审定。
 */
export const DEFAULT_CRITICAL_RULES: readonly CriticalRule[] = [
  { metric: 'sbp', comparator: 'gte', value: 180, level: 'urgent' },
  { metric: 'dbp', comparator: 'gte', value: 120, level: 'urgent' },
  { metric: 'sbp', comparator: 'lt', value: 90, level: 'attention' },
  { metric: 'fpg', comparator: 'lt', value: 3.0, level: 'urgent' },
  { metric: 'fpg', comparator: 'gte', value: 16.7, level: 'urgent' },
  { metric: 'heart_rate', comparator: 'lt', value: 40, level: 'urgent' },
  { metric: 'heart_rate', comparator: 'gt', value: 130, level: 'urgent' },
  { metric: 'uric_acid', comparator: 'gte', value: 540, level: 'attention' },
];

/** 数值是否命中规则 */
export function matchesRule(
  rule: Pick<CriticalRule, 'comparator' | 'value'>,
  value: number,
): boolean {
  switch (rule.comparator) {
    case 'gte':
      return value >= rule.value;
    case 'gt':
      return value > rule.value;
    case 'lte':
      return value <= rule.value;
    case 'lt':
      return value < rule.value;
  }
}

/** 客户档案里的一个数值，用来识别危急指标 */
export interface Observation {
  metric: string;
  value: number;
  unit: string;
  /** YYYY-MM-DD */
  observedOn: string;
  source: 'monitoring' | 'report';
}

/**
 * 识别危急指标（M1 规格第五节之二）：每个指标在每个来源里取最近一次数值，逐条和启用的规则比对。
 * 命中的规则以快照形式写进结果，阈值以后改了也能追溯。需尽快就医的排在前面。
 */
export function detectCriticalFlags(
  rules: readonly (CriticalRule & { enabled?: boolean })[],
  observations: readonly Observation[],
): CriticalFlag[] {
  const latest = new Map<string, Observation>();
  for (const o of observations) {
    const key = `${o.source}:${o.metric}`;
    const current = latest.get(key);
    if (!current || o.observedOn > current.observedOn) latest.set(key, o);
  }
  const flags: CriticalFlag[] = [];
  for (const o of latest.values()) {
    for (const r of rules) {
      if (r.enabled === false || r.metric !== o.metric || !matchesRule(r, o.value)) continue;
      flags.push({
        metric: o.metric,
        value: o.value,
        unit: o.unit,
        observedOn: o.observedOn,
        source: o.source,
        rule: { comparator: r.comparator, value: r.value, level: r.level },
      });
    }
  }
  const rank = { urgent: 0, attention: 1 } as const;
  return flags.sort(
    (a, b) =>
      rank[a.rule.level] - rank[b.rule.level] ||
      a.metric.localeCompare(b.metric) ||
      a.source.localeCompare(b.source),
  );
}
