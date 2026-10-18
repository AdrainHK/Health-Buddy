/**
 * 客户数字孪生的红黄绿状态（M4 规格第四节、第五节之二）。
 *
 * 状态由后端按平台设定的规则确定性计算，AI 不参与（Q1、Q2、Q4）。
 * 这里放四个方面的指标映射、默认规则和计算状态的纯函数。
 *
 * **默认规则和各项参数（监测窗口 7 天、报告过期 12 个月）是候选做法，不是医学标准，
 * 全部待产品负责人和医学顾问审定**；正式标准确定后只替换规则表。
 */
import type { TwinBasisItem, TwinRuleHit, TwinSkippedValue } from '../api/twin.js';
import { MONITORING_METRICS, REPORT_INDICATORS } from './catalog.js';
import type { MonitoringMetricCode, ReportIndicatorCode } from './catalog.js';
import {
  THRESHOLD_BOUNDS,
  indicatorUnit,
  matchesRule,
  type CriticalComparator,
  type CriticalRule,
  type IndicatorCode,
} from './critical.js';
import type { AbnormalFlag } from './reference.js';

/** 四个方面：代谢、心血管、睡眠、体重 */
export const TWIN_DOMAINS = ['metabolic', 'cardiovascular', 'sleep', 'weight'] as const;
export type TwinDomain = (typeof TWIN_DOMAINS)[number];

/** 红（需要尽快关注）、黄（需要留意）、绿（平稳）、灰（数据不足） */
export const TWIN_LEVELS = ['red', 'yellow', 'green', 'unknown'] as const;
export type TwinLevel = (typeof TWIN_LEVELS)[number];

export const TWIN_RULE_SOURCES = ['report', 'monitoring'] as const;
export type TwinRuleSource = (typeof TWIN_RULE_SOURCES)[number];

/**
 * 判断方式（第五节之二）：
 * - critical：命中 M1 危急阈值；
 * - out_of_reference：报告指标超出报告上印的参考范围（M2 Q10），只用于报告；
 * - threshold：监测指标最近 N 天平均值超出平台设定的固定阈值，只用于监测。
 */
export const TWIN_RULE_METHODS = ['critical', 'out_of_reference', 'threshold'] as const;
export type TwinRuleMethod = (typeof TWIN_RULE_METHODS)[number];

/** 规则只能得出红或黄；绿是“有数据且没有命中任何规则” */
export const TWIN_RULE_LEVELS = ['red', 'yellow'] as const;
export type TwinRuleLevel = (typeof TWIN_RULE_LEVELS)[number];

/**
 * 每个方面包含的指标（4.1，Q3）。血脂只算在代谢里，避免同一个数值让两个方面一起变色；
 * 肝肾功能不归入任何方面。
 */
export const domainMetrics = {
  metabolic: {
    report: ['fpg', 'hba1c', 'tc', 'tg', 'ldl_c', 'hdl_c', 'uric_acid'],
    monitoring: ['fpg'],
  },
  cardiovascular: {
    report: ['sbp', 'dbp'],
    monitoring: ['sbp', 'dbp', 'heart_rate'],
  },
  sleep: {
    report: [],
    monitoring: ['sleep_hours'],
  },
  weight: {
    report: ['weight', 'bmi', 'waist'],
    monitoring: ['weight'],
  },
} as const satisfies Record<
  TwinDomain,
  { report: readonly ReportIndicatorCode[]; monitoring: readonly MonitoringMetricCode[] }
>;

/** 指标属于哪个方面（每个指标在每个来源里最多属于一个方面） */
export function domainOfMetric(source: TwinRuleSource, metric: string): TwinDomain | null {
  for (const d of TWIN_DOMAINS) {
    if ((domainMetrics[d][source] as readonly string[]).includes(metric)) return d;
  }
  return null;
}

/** 监测指标取最近 N 天（Q2 推荐 7 天，待审定） */
export const TWIN_MONITORING_WINDOW_DAYS = 7;
/** 报告指标的最近数值早于 N 个月视为过期（Q2 推荐 12 个月，待审定） */
export const TWIN_REPORT_STALE_MONTHS = 12;
/** 手动调整的理由至少 5 个字（2.3） */
export const TWIN_REASON_MIN = 5;
export const TWIN_REASON_MAX = 500;

export interface TwinStatusRuleDef {
  domain: TwinDomain;
  metric: IndicatorCode;
  source: TwinRuleSource;
  method: TwinRuleMethod;
  /** 只有 threshold 类有比较方式、阈值和单位 */
  comparator: CriticalComparator | null;
  value: number | null;
  unit: string | null;
  /** 监测规则的时间窗口（天）；报告规则为空 */
  windowDays: number | null;
  level: TwinRuleLevel;
}

export interface TwinStatusRule extends TwinStatusRuleDef {
  id: string;
  enabled: boolean;
}

function catalogDef(code: string) {
  return [...REPORT_INDICATORS, ...MONITORING_METRICS].find((d) => d.code === code) as
    { code: string; unit: string; refLow?: number; refHigh?: number } | undefined;
}

/**
 * 平台默认规则（第五节之二，Q2 推荐答案 A）。**通用的初步做法，不是医学标准，待医学顾问审定。**
 * - 每个方面的每个指标（报告和监测分别）：命中危急阈值 → 红（urgent、attention 两档都算红）；
 * - 每个报告指标：超出报告上印的参考范围 → 黄；
 * - 监测指标：最近 7 天平均超出目录 MONITORING_METRICS 的 refLow/refHigh → 黄；
 *   睡眠时长、体重、步数目录里没有范围，默认不设 threshold 规则，等顾问给出。
 */
export const DEFAULT_TWIN_STATUS_RULES: readonly TwinStatusRuleDef[] = TWIN_DOMAINS.flatMap(
  (domain) => {
    const rules: TwinStatusRuleDef[] = [];
    const base = { domain, comparator: null, value: null, unit: null } as const;
    for (const metric of domainMetrics[domain].report) {
      rules.push({
        ...base,
        metric,
        source: 'report',
        method: 'critical',
        windowDays: null,
        level: 'red',
      });
      rules.push({
        ...base,
        metric,
        source: 'report',
        method: 'out_of_reference',
        windowDays: null,
        level: 'yellow',
      });
    }
    for (const metric of domainMetrics[domain].monitoring) {
      rules.push({
        ...base,
        metric,
        source: 'monitoring',
        method: 'critical',
        windowDays: TWIN_MONITORING_WINDOW_DAYS,
        level: 'red',
      });
      const def = catalogDef(metric);
      const thr = { domain, metric, source: 'monitoring', method: 'threshold' } as const;
      const common = {
        unit: def?.unit ?? null,
        windowDays: TWIN_MONITORING_WINDOW_DAYS,
        level: 'yellow',
      } as const;
      if (def?.refHigh !== undefined)
        rules.push({ ...thr, ...common, comparator: 'gt', value: def.refHigh });
      if (def?.refLow !== undefined)
        rules.push({ ...thr, ...common, comparator: 'lt', value: def.refLow });
    }
    return rules;
  },
);

/** 规则的形状是否合法（数据库的 check 和触发器做同样的校验） */
export function twinRuleShapeError(rule: TwinStatusRuleDef): string | null {
  if (!(domainMetrics[rule.domain][rule.source] as readonly string[]).includes(rule.metric))
    return 'metric not in domain';
  if (rule.method === 'out_of_reference' && rule.source !== 'report')
    return 'out_of_reference is for reports';
  if (rule.method === 'threshold' && rule.source !== 'monitoring')
    return 'threshold is for monitoring';
  if (rule.method === 'threshold') {
    if (rule.comparator === null || rule.value === null || rule.unit === null)
      return 'threshold needs comparator, value and unit';
    if (rule.unit !== indicatorUnit(rule.metric)) return 'unit must follow the catalog';
    const b = THRESHOLD_BOUNDS[rule.metric];
    if (rule.value < b.min || rule.value > b.max) return 'value out of range';
  } else if (rule.comparator !== null || rule.value !== null || rule.unit !== null) {
    return 'only threshold rules have comparator, value and unit';
  }
  if ((rule.source === 'monitoring') !== (rule.windowDays !== null))
    return 'window_days is for monitoring rules';
  if (rule.windowDays !== null && (rule.windowDays < 1 || rule.windowDays > 90))
    return 'window_days out of range';
  return null;
}

/** 已核对报告里的一个指标值（未核对的识别结果不传进来） */
export interface TwinReportValue {
  indicatorId: string;
  reportId: string;
  metric: string;
  value: number;
  unit: string;
  /** YYYY-MM-DD */
  reportDate: string;
  refLow: number | null;
  refHigh: number | null;
  /** 后端按报告上印的参考范围算好的高低标记（M2 Q10） */
  abnormal: AbnormalFlag;
  /** 被更正替代时指向新行；被替代的值不参与计算 */
  supersededBy?: string | null;
}

export interface TwinMonitoringReading {
  id: string;
  metric: string;
  value: number;
  unit: string;
  /** ISO 时间 */
  measuredAt: string;
}

export interface EvaluateTwinInput {
  /** 平台规则（含停用的，函数自己跳过） */
  rules: readonly TwinStatusRule[];
  rulesVersion: number;
  /** M1 危急阈值 */
  criticalRules: readonly (CriticalRule & { enabled?: boolean })[];
  reportValues: readonly TwinReportValue[];
  readings: readonly TwinMonitoringReading[];
  /** 计算时刻（ISO），决定监测窗口和报告是否过期 */
  now: string;
}

export interface TwinDomainStatus {
  domain: TwinDomain;
  level: TwinLevel;
  basis: TwinBasisItem[];
  /** 没有参与判断的数值和原因（单位不符、超出合理范围、报告过期） */
  skipped: TwinSkippedValue[];
  rulesVersion: number;
}

const SEVERITY: Record<TwinLevel, number> = { red: 3, yellow: 2, green: 1, unknown: 0 };

/** 取更严重的状态（红 > 黄 > 绿 > 灰） */
export function worstTwinLevel(levels: Iterable<TwinLevel>): TwinLevel {
  let worst: TwinLevel = 'unknown';
  for (const l of levels) if (SEVERITY[l] > SEVERITY[worst]) worst = l;
  return worst;
}

/** 单个数值的判断结果：命中规则里最严重的，没命中为绿 */
function outcomeOf(hits: readonly TwinRuleHit[]): 'red' | 'yellow' | 'green' {
  if (hits.some((h) => h.level === 'red')) return 'red';
  return hits.length > 0 ? 'yellow' : 'green';
}

const DAY_MS = 86_400_000;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 日期加月（按日历，月底对齐到当月最后一天） */
export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** 数值是否可用：单位跟目录一致、落在合理范围内 */
function usability(metric: string, value: number, unit: string): TwinSkippedValue['reason'] | null {
  const code = metric as IndicatorCode;
  const bounds = THRESHOLD_BOUNDS[code];
  if (!bounds) return 'not_in_catalog';
  if (unit !== indicatorUnit(code)) return 'unit_mismatch';
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) return 'out_of_bounds';
  return null;
}

function criticalHits(
  rule: TwinStatusRule,
  criticalRules: EvaluateTwinInput['criticalRules'],
  value: number,
): TwinRuleHit[] {
  return criticalRules
    .filter((c) => c.enabled !== false && c.metric === rule.metric && matchesRule(c, value))
    .map((c) => ({
      ruleId: rule.id,
      method: 'critical' as const,
      level: rule.level,
      snapshot: {
        comparator: c.comparator,
        value: c.value,
        unit: indicatorUnit(rule.metric),
        windowDays: rule.windowDays,
        criticalLevel: c.level,
      },
    }));
}

/**
 * 计算一个方面的状态（4.2）：
 * 1. 报告指标取最近一份已核对报告里的值（被更正替代的不算）；早于 12 个月的视为过期，不参与；
 * 2. 监测指标取最近 N 天的读数：危急阈值看窗口内最近一条，固定阈值看窗口内平均值；
 * 3. 每个数值按启用的规则判断红黄绿，方面取最严重的；
 * 4. 没有任何可用数值时为灰（数据不足）。
 * 单位和目录不一致、超出合理范围（明显误填）的数值不参与，记在 skipped 里。
 * 依据记录每个数值的指标、来源、日期、命中的规则 id 和规则快照。
 */
export function evaluateDomainStatus(
  domain: TwinDomain,
  input: EvaluateTwinInput,
): TwinDomainStatus {
  const nowMs = Date.parse(input.now);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const staleBefore = addMonthsIso(today, -TWIN_REPORT_STALE_MONTHS);
  const rules = input.rules.filter((r) => r.enabled && r.domain === domain);
  const basis: TwinBasisItem[] = [];
  const skipped: TwinSkippedValue[] = [];

  // 报告：每个指标取最近一次（同一天的多条，取输入里靠后的一条）
  const latestReport = new Map<string, TwinReportValue>();
  for (const v of input.reportValues) {
    if (v.supersededBy) continue;
    if (!(domainMetrics[domain].report as readonly string[]).includes(v.metric)) continue;
    const current = latestReport.get(v.metric);
    if (!current || v.reportDate >= current.reportDate) latestReport.set(v.metric, v);
  }
  for (const metric of domainMetrics[domain].report) {
    const v = latestReport.get(metric);
    if (!v) continue;
    const bad = usability(metric, v.value, v.unit);
    if (bad) {
      skipped.push({ metric, source: 'report', observedOn: v.reportDate, reason: bad });
      continue;
    }
    if (v.reportDate < staleBefore) {
      skipped.push({ metric, source: 'report', observedOn: v.reportDate, reason: 'stale' });
      continue;
    }
    const hits: TwinRuleHit[] = [];
    for (const r of rules) {
      if (r.source !== 'report' || r.metric !== metric) continue;
      if (r.method === 'critical') hits.push(...criticalHits(r, input.criticalRules, v.value));
      // 报告没印参考范围时不按“参考范围”类规则判断（4.2 第 6 条）
      if (r.method === 'out_of_reference' && (v.abnormal === 'high' || v.abnormal === 'low'))
        hits.push({
          ruleId: r.id,
          method: 'out_of_reference',
          level: r.level,
          snapshot: { refLow: v.refLow, refHigh: v.refHigh, abnormal: v.abnormal },
        });
    }
    basis.push({
      metric,
      source: 'report',
      value: v.value,
      unit: v.unit,
      observedOn: v.reportDate,
      reportId: v.reportId,
      indicatorId: v.indicatorId,
      refLow: v.refLow,
      refHigh: v.refHigh,
      noReference: v.abnormal === 'no_reference',
      outcome: outcomeOf(hits),
      hits,
    });
  }

  // 监测：每个指标在最长的规则窗口内取读数，逐条规则按各自的窗口判断
  for (const metric of domainMetrics[domain].monitoring) {
    const metricRules = rules.filter((r) => r.source === 'monitoring' && r.metric === metric);
    const windowDays = Math.max(
      TWIN_MONITORING_WINDOW_DAYS,
      ...metricRules.map((r) => r.windowDays ?? 0),
    );
    const inWindow = (r: TwinMonitoringReading, days: number) => {
      const t = Date.parse(r.measuredAt);
      return t <= nowMs && t > nowMs - days * DAY_MS;
    };
    const usable: TwinMonitoringReading[] = [];
    for (const r of input.readings) {
      if (r.metric !== metric || !inWindow(r, windowDays)) continue;
      const bad = usability(metric, r.value, r.unit);
      if (bad)
        skipped.push({
          metric,
          source: 'monitoring',
          observedOn: r.measuredAt.slice(0, 10),
          reason: bad,
        });
      else usable.push(r);
    }
    // 状态用的默认窗口里没有读数：这个指标视为没有近期数据
    const recent = usable.filter((r) => inWindow(r, TWIN_MONITORING_WINDOW_DAYS));
    if (recent.length === 0) continue;
    const sorted = [...recent].sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
    const latest = sorted[sorted.length - 1]!;
    const average = round3(sorted.reduce((s, r) => s + r.value, 0) / sorted.length);

    const hits: TwinRuleHit[] = [];
    for (const r of metricRules) {
      const days = r.windowDays ?? TWIN_MONITORING_WINDOW_DAYS;
      const scoped = usable.filter((x) => inWindow(x, days));
      if (scoped.length === 0) continue;
      if (r.method === 'critical') {
        const last = scoped.reduce((a, b) =>
          Date.parse(b.measuredAt) >= Date.parse(a.measuredAt) ? b : a,
        );
        hits.push(...criticalHits(r, input.criticalRules, last.value));
      } else if (r.method === 'threshold' && r.comparator !== null && r.value !== null) {
        if (r.unit !== indicatorUnit(metric as IndicatorCode)) continue;
        const avg = scoped.reduce((s, x) => s + x.value, 0) / scoped.length;
        if (matchesRule({ comparator: r.comparator, value: r.value }, round3(avg)))
          hits.push({
            ruleId: r.id,
            method: 'threshold',
            level: r.level,
            snapshot: {
              comparator: r.comparator,
              value: r.value,
              unit: r.unit ?? '',
              windowDays: days,
              average: round3(avg),
              count: scoped.length,
            },
          });
      }
    }
    basis.push({
      metric,
      source: 'monitoring',
      value: average,
      unit: latest.unit,
      observedOn: latest.measuredAt.slice(0, 10),
      windowDays: TWIN_MONITORING_WINDOW_DAYS,
      count: sorted.length,
      from: sorted[0]!.measuredAt.slice(0, 10),
      latestValue: latest.value,
      latestReadingId: latest.id,
      outcome: outcomeOf(hits),
      hits,
    });
  }

  return {
    domain,
    level: worstTwinLevel(basis.map((b) => b.outcome)),
    basis,
    skipped,
    rulesVersion: input.rulesVersion,
  };
}

/** 四个方面一起算 */
export function evaluateTwinStatus(input: EvaluateTwinInput): TwinDomainStatus[] {
  return TWIN_DOMAINS.map((d) => evaluateDomainStatus(d, input));
}
