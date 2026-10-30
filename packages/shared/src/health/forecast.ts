/**
 * 指标数值的趋势预测（M4 规格第六节，Q6–Q9、Q11）。
 *
 * 方法：普通最小二乘直线拟合 + 80% 预测区间（按拟合残差和样本数计算 t 分布区间），
 * 后端确定性计算，大模型只引用结果、不推算。**只预测指标数值的走势，不预测任何疾病或患病概率。**
 *
 * **方法、窗口、最少数据量和不确定性界限都是候选做法，待产品负责人和医学顾问审定**；
 * 改动任何参数时升 FORECAST_METHOD_VERSION。
 */
import type { ForecastPoint, ForecastResult } from '../api/twin.js';
import { THRESHOLD_BOUNDS, indicatorUnit, type IndicatorCode } from './critical.js';
import { addMonthsIso, type TwinValueSource } from './twin.js';

/** 方法和参数的版本号，写进每条预测 */
export const FORECAST_METHOD_VERSION = 'ols-linear-v1';
export const FORECAST_INTERVAL_LEVEL = 0.8;

/** 做预测的指标（Q9）。肝肾功能指标、未收录指标不做 */
export const FORECAST_METRICS = [
  'weight',
  'bmi',
  'waist',
  'sbp',
  'dbp',
  'heart_rate',
  'fpg',
  'hba1c',
  'tc',
  'tg',
  'ldl_c',
  'hdl_c',
  'uric_acid',
  'sleep_hours',
  'steps',
] as const satisfies readonly IndicatorCode[];
export type ForecastMetric = (typeof FORECAST_METRICS)[number];

/**
 * 最少数据量（6.2，Q7）：报告指标至少 3 次已核对数值，监测至少 8 个有效周。
 * 预测时长还受数据跨度限制，见 forecastMetric。
 */
export const FORECAST_MIN_POINTS: Record<TwinValueSource, number> = { report: 3, monitoring: 8 };
/** 报告指标取最近 24 个月 */
export const FORECAST_REPORT_WINDOW_MONTHS = 24;
/** 监测指标取最近 26 周的周平均 */
export const FORECAST_MONITORING_WINDOW_WEEKS = 26;
/** 一周至少 3 条读数才算一个有效周 */
export const FORECAST_MIN_READINGS_PER_WEEK = 3;
/** 报告指标：跨度至少 6 个月才预测 3 个月，至少 12 个月才预测 6 个月 */
export const FORECAST_REPORT_SPAN_MONTHS = { 3: 6, 6: 12 } as const;
/** 监测指标：有效周覆盖至少 13 周（91 天）才预测 3 个月（预测时长不超过数据跨度） */
export const FORECAST_MONITORING_SPAN_DAYS_FOR_3M = 91;
/** 监测指标：有效周达到 26 个才预测 6 个月 */
export const FORECAST_MONITORING_WEEKS_FOR_6M = 26;

/**
 * 不确定性“高”的界限（6.3，Q8）：最远一个预测点的区间宽度超过这个值时标“高”。
 * 规格只举了收缩压 30 mmHg 的例子，其余是候选值，**待医学顾问给出**。单位跟指标目录。
 */
export const FORECAST_WIDE_INTERVAL: Record<ForecastMetric, number> = {
  weight: 6,
  bmi: 2.5,
  waist: 8,
  sbp: 30,
  dbp: 20,
  heart_rate: 20,
  fpg: 1.5,
  hba1c: 1,
  tc: 1.5,
  tg: 1.5,
  ldl_c: 1.2,
  hdl_c: 0.5,
  uric_acid: 120,
  sleep_hours: 2,
  steps: 4000,
};

const DAY_MS = 86_400_000;

export function isForecastMetric(metric: string): metric is ForecastMetric {
  return (FORECAST_METRICS as readonly string[]).includes(metric);
}

/**
 * 双侧 80% 区间用的 t 分布分位数 t(0.9, df)。df ≤ 30 查表，更大时用 Cornish-Fisher 展开，
 * 和查表值相差不到 0.001。
 */
const T90 = [
  3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345,
  1.341, 1.337, 1.333, 1.33, 1.328, 1.325, 1.323, 1.321, 1.319, 1.318, 1.316, 1.315, 1.314, 1.313,
  1.311, 1.31,
];
export function tQuantile90(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 30) return T90[Math.floor(df) - 1]!;
  const z = 1.2815516;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2);
}

export interface LinearFit {
  n: number;
  /** 截距和斜率；x 是相对 origin 的天数 */
  intercept: number;
  slope: number;
  meanX: number;
  sxx: number;
  /** 残差标准差 sqrt(SSE / (n - 2)) */
  residualSd: number;
}

/** 普通最小二乘直线拟合。点数少于 3 或 x 全相同时返回 null */
export function fitLine(xs: readonly number[], ys: readonly number[]): LinearFit | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - meanX) ** 2;
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  return { n, intercept, slope, meanX, sxx, residualSd: Math.sqrt(sse / (n - 2)) };
}

/** 在 x 处的中间值和 80% 预测区间 */
export function predictAt(fit: LinearFit, x: number): { mid: number; low: number; high: number } {
  const mid = fit.intercept + fit.slope * x;
  const half =
    tQuantile90(fit.n - 2) *
    fit.residualSd *
    Math.sqrt(1 + 1 / fit.n + (x - fit.meanX) ** 2 / fit.sxx);
  return { mid, low: mid - half, high: mid + half };
}

export interface ForecastObservation {
  /** 报告日期（YYYY-MM-DD）或监测时间（ISO） */
  at: string;
  value: number;
  unit: string;
  /** 报告指标被更正替代时指向新行，不参与 */
  supersededBy?: string | null;
}

export interface ForecastInput {
  metric: string;
  source: TwinValueSource;
  observations: readonly ForecastObservation[];
  /** 计算时刻（ISO） */
  now: string;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayMs(iso: string): number {
  return Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function clamp(n: number, b: { min: number; max: number }): number {
  return Math.min(b.max, Math.max(b.min, n));
}

/** 可用的数值：单位和目录一致、在合理范围内、没有被更正替代 */
function usable(metric: IndicatorCode, o: ForecastObservation, nowMs: number): boolean {
  const b = THRESHOLD_BOUNDS[metric];
  return (
    !o.supersededBy &&
    o.unit === indicatorUnit(metric) &&
    Number.isFinite(o.value) &&
    o.value >= b.min &&
    o.value <= b.max &&
    dayMs(o.at) <= nowMs
  );
}

export interface WeeklyAverage {
  /** 0 是包含 now 的这一周，往前递增 */
  weekIndex: number;
  /** 这一周的起止日期（含） */
  from: string;
  to: string;
  /** 用来拟合的时间点：这一周的中点 */
  midAt: number;
  average: number;
  count: number;
}

/**
 * 监测读数按周取平均（6.1）：从 now 往前每 7 天一周，取最近 26 周；
 * 一周至少 3 条读数才算有效周。偏离判断也用这个函数算新数据所在周的平均（6.4）。
 */
export function weeklyAverages(
  readings: readonly { at: string; value: number }[],
  now: string,
  weeks = FORECAST_MONITORING_WINDOW_WEEKS,
): WeeklyAverage[] {
  const nowMs = Date.parse(now);
  const buckets = new Map<number, number[]>();
  for (const r of readings) {
    const t = dayMs(r.at);
    if (t > nowMs) continue;
    const idx = Math.floor((nowMs - t) / (7 * DAY_MS));
    if (idx >= weeks) continue;
    const list = buckets.get(idx) ?? [];
    list.push(r.value);
    buckets.set(idx, list);
  }
  const out: WeeklyAverage[] = [];
  for (const [idx, values] of buckets) {
    if (values.length < FORECAST_MIN_READINGS_PER_WEEK) continue;
    const endMs = nowMs - idx * 7 * DAY_MS;
    const startMs = endMs - 7 * DAY_MS;
    out.push({
      weekIndex: idx,
      from: isoDay(startMs + 1),
      to: isoDay(endMs),
      midAt: (startMs + endMs) / 2,
      average: round3(values.reduce((s, v) => s + v, 0) / values.length),
      count: values.length,
    });
  }
  return out.sort((a, b) => b.weekIndex - a.weekIndex);
}

function insufficient(
  base: Pick<ForecastResult, 'metric' | 'source' | 'methodVersion' | 'intervalLevel'>,
  nPoints: number,
  spanDays: number,
  reason: 'not_forecastable' | 'too_few_points' | 'span_too_short',
  needed: number | null,
): ForecastResult {
  return {
    ...base,
    status: 'insufficient_data',
    insufficientReason: reason,
    pointsNeeded: needed,
    nPoints,
    spanDays,
    horizonMonths: null,
    uncertainty: null,
    basis: null,
    fit: null,
    points: [],
  };
}

/**
 * 预测一个指标（6.1–6.3）：
 * - 报告指标：最近 24 个月的已核对数值，至少 3 次、最早和最近相隔至少 6 个月；
 *   跨度 6–11 个月只给 3 个月，≥ 12 个月给 3 个月和 6 个月。
 * - 监测指标：最近 26 周的有效周平均，至少 8 个有效周；**预测时长不超过数据跨度**，
 *   所以有效周覆盖不到 3 个月时也不预测；26 个有效周才给 6 个月。
 * - 预测点从最近一个数据点起算（3 个月、6 个月后），外推距离就是预测时长。
 * - 中间值和区间截在 THRESHOLD_BOUNDS 的合理范围内（不会算出负的体重）。
 * - 不确定性“高”：数据次数刚好达到最少要求，或最远一个预测点的区间宽于 FORECAST_WIDE_INTERVAL。
 */
export function forecastMetric(input: ForecastInput): ForecastResult {
  const base = {
    metric: input.metric,
    source: input.source,
    methodVersion: FORECAST_METHOD_VERSION,
    intervalLevel: FORECAST_INTERVAL_LEVEL,
  };
  if (!isForecastMetric(input.metric)) return insufficient(base, 0, 0, 'not_forecastable', null);
  const metric = input.metric;
  const nowMs = Date.parse(input.now);
  const minPoints = FORECAST_MIN_POINTS[input.source];

  // 拟合用的点：x 为毫秒时间，y 为数值
  let pts: { t: number; y: number }[];
  let spanDays: number;
  let spanFrom: string;
  let spanTo: string;
  let horizons: (3 | 6)[];

  if (input.source === 'report') {
    const windowStart = dayMs(addMonthsIso(isoDay(nowMs), -FORECAST_REPORT_WINDOW_MONTHS));
    pts = input.observations
      .filter((o) => usable(metric, o, nowMs) && dayMs(o.at) >= windowStart)
      .map((o) => ({ t: dayMs(o.at.slice(0, 10)), y: o.value }))
      .sort((a, b) => a.t - b.t);
    const first = pts[0]?.t ?? 0;
    const last = pts[pts.length - 1]?.t ?? 0;
    spanDays = Math.round((last - first) / DAY_MS);
    if (pts.length < minPoints)
      return insufficient(base, pts.length, spanDays, 'too_few_points', minPoints - pts.length);
    spanFrom = isoDay(first);
    spanTo = isoDay(last);
    horizons = [];
    if (addMonthsIso(spanFrom, FORECAST_REPORT_SPAN_MONTHS[3]) <= spanTo) horizons.push(3);
    if (addMonthsIso(spanFrom, FORECAST_REPORT_SPAN_MONTHS[6]) <= spanTo) horizons.push(6);
    if (horizons.length === 0)
      return insufficient(base, pts.length, spanDays, 'span_too_short', null);
  } else {
    const weeks = weeklyAverages(
      input.observations.filter((o) => usable(metric, o, nowMs)),
      input.now,
    );
    pts = weeks.map((w) => ({ t: w.midAt, y: w.average }));
    // 跨度按有效周覆盖的整周算：最早一周的第一天到最近一周的最后一天
    const firstWeek = weeks[0];
    const lastWeek = weeks[weeks.length - 1];
    spanFrom = firstWeek?.from ?? isoDay(nowMs);
    spanTo = lastWeek?.to ?? isoDay(nowMs);
    spanDays = firstWeek && lastWeek ? (firstWeek.weekIndex - lastWeek.weekIndex + 1) * 7 : 0;
    if (pts.length < minPoints)
      return insufficient(base, pts.length, spanDays, 'too_few_points', minPoints - pts.length);
    horizons = [];
    // 3 个月按 13 周（91 天）计；26 个有效周覆盖整个窗口（182 天），按 6 个月计
    if (spanDays >= FORECAST_MONITORING_SPAN_DAYS_FOR_3M) horizons.push(3);
    if (pts.length >= FORECAST_MONITORING_WEEKS_FOR_6M) horizons.push(6);
    if (horizons.length === 0)
      return insufficient(base, pts.length, spanDays, 'span_too_short', null);
  }

  // x 用相对第一个点的天数，数值更稳定
  const origin = pts[0]!.t;
  const xs = pts.map((p) => (p.t - origin) / DAY_MS);
  const fit = fitLine(
    xs,
    pts.map((p) => p.y),
  );
  if (!fit) return insufficient(base, pts.length, spanDays, 'span_too_short', null);

  const bounds = THRESHOLD_BOUNDS[metric];
  // 预测从最近一个数据点起算
  const anchorMs = pts[pts.length - 1]!.t;
  const anchor = isoDay(anchorMs);
  const points: ForecastPoint[] = horizons.map((h) => {
    const date = addMonthsIso(anchor, h);
    const x = (dayMs(date) - origin) / DAY_MS;
    const p = predictAt(fit, x);
    const clipped = p.low < bounds.min || p.high > bounds.max;
    return {
      monthsAhead: h,
      date,
      mid: round3(clamp(p.mid, bounds)),
      low: round3(clamp(p.low, bounds)),
      high: round3(clamp(p.high, bounds)),
      clipped,
    };
  });
  const furthest = points[points.length - 1]!;
  const wide = furthest.high - furthest.low > FORECAST_WIDE_INTERVAL[metric];
  const atMinimum = pts.length === minPoints;

  return {
    ...base,
    status: 'ok',
    insufficientReason: null,
    pointsNeeded: null,
    nPoints: pts.length,
    spanDays,
    horizonMonths: horizons[horizons.length - 1]!,
    uncertainty: wide || atMinimum ? 'high' : 'normal',
    basis: {
      kind: input.source === 'report' ? 'report_values' : 'weekly_averages',
      from: spanFrom,
      to: spanTo,
      anchor,
    },
    fit: {
      origin: isoDay(origin),
      originAt: new Date(origin).toISOString(),
      n: fit.n,
      intercept: fit.intercept,
      slopePerDay: fit.slope,
      meanX: fit.meanX,
      sxx: fit.sxx,
      residualSd: fit.residualSd,
    },
    points,
  };
}

export type DeviationDirection = 'worse' | 'better' | 'unknown';
export type DeviationResult =
  | { judged: false; reason: 'insufficient' | 'high_uncertainty' | 'outside_horizon' }
  | {
      judged: true;
      deviated: boolean;
      expected: { mid: number; low: number; high: number };
      side: 'above' | 'below' | null;
      direction: DeviationDirection | null;
    };

/**
 * 偏离预测（6.4，Q11）：用**这条数据进来之前**最新的那份预测，看新数据是否落在当天的 80% 区间之外。
 * - 报告指标传已核对的数值和报告日期；监测指标传有效周的周平均和这一周的中点（单条读数不判断）。
 * - 不确定性“高”、数据不足的预测不判断；新数据早于预测起点或晚于最远预测点也不判断。
 * - 方向：和中间值相比离参考范围更远算变差，更近算变好；指标没有参考范围时为 unknown。
 *   参考范围由调用方给（报告用报告上印的，监测用目录的）。
 */
export function isDeviation(
  forecast: ForecastResult,
  observation: { at: string; value: number },
  reference: { low: number | null; high: number | null } = { low: null, high: null },
): DeviationResult {
  if (forecast.status !== 'ok' || !forecast.fit || !forecast.basis)
    return { judged: false, reason: 'insufficient' };
  if (forecast.uncertainty === 'high') return { judged: false, reason: 'high_uncertainty' };
  const t = dayMs(observation.at);
  const last = forecast.points[forecast.points.length - 1];
  if (!last || t <= dayMs(forecast.basis.anchor) || t > dayMs(last.date) + DAY_MS - 1)
    return { judged: false, reason: 'outside_horizon' };

  const f = forecast.fit;
  const fit: LinearFit = {
    n: f.n,
    intercept: f.intercept,
    slope: f.slopePerDay,
    meanX: f.meanX,
    sxx: f.sxx,
    residualSd: f.residualSd,
  };
  const p = predictAt(fit, (t - Date.parse(f.originAt)) / DAY_MS);
  const expected = { mid: round3(p.mid), low: round3(p.low), high: round3(p.high) };
  const v = observation.value;
  if (v >= expected.low && v <= expected.high)
    return { judged: true, deviated: false, expected, side: null, direction: null };

  const side = v > expected.high ? 'above' : 'below';
  let direction: DeviationDirection = 'unknown';
  if (reference.low !== null || reference.high !== null) {
    const distance = (x: number) =>
      Math.max(
        0,
        reference.low !== null ? reference.low - x : 0,
        reference.high !== null ? x - reference.high : 0,
      );
    const dObs = distance(v);
    const dMid = distance(expected.mid);
    if (dObs > dMid) direction = 'worse';
    else if (dObs < dMid) direction = 'better';
    // 都在参考范围内：按偏离的方向看朝哪一侧界限靠近
    else if (side === 'above') direction = reference.high !== null ? 'worse' : 'better';
    else direction = reference.low !== null ? 'worse' : 'better';
  }
  return { judged: true, deviated: true, expected, side, direction };
}
