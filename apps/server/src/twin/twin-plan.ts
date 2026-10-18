import {
  FORECAST_METRICS,
  FORECAST_MONITORING_WINDOW_WEEKS,
  MONITORING_METRICS,
  THRESHOLD_BOUNDS,
  TWIN_DOMAINS,
  TWIN_MONITORING_WINDOW_DAYS,
  domainOfMetric,
  evaluateTwinStatus,
  forecastMetric,
  indicatorUnit,
  isBatchTwinTrigger,
  isDeviation,
  matchesRule,
  weeklyAverages,
  type CriticalRule,
  type FollowUpKind,
  type FollowUpSeverity,
  type ForecastResult,
  type IndicatorCode,
  type TwinBasisItem,
  type TwinComputeTrigger,
  type TwinDomain,
  type TwinLevel,
  type TwinMonitoringReading,
  type TwinReportValue,
  type TwinStatusRule,
} from '@health-buddy/shared';

/**
 * 孪生计算的“计划”（M4 规格 2.6、3.2、4.2、6.4）：纯函数，不读写数据库。
 * 输入是计算任务在健管师上下文里读到的数据，输出是要写入的状态历史、预测和跟进项。
 * 依据和跟进项的内容含健康数值，只写数据库，不进日志和任务参数。
 */

const DAY_MS = 86_400_000;

export interface PlanReportValue extends TwinReportValue {
  /** 写入时间（核对、更正的时间） */
  createdAt: string;
}

export interface PlanReading extends TwinMonitoringReading {
  createdAt: string;
}

export interface StoredForecast {
  id: string;
  computedAt: string;
  result: ForecastResult;
}

export interface PlanInput {
  /** 计算时刻（读数据时的数据库时间） */
  now: string;
  trigger: TwinComputeTrigger;
  rules: readonly TwinStatusRule[];
  rulesVersion: number;
  criticalRules: readonly (CriticalRule & { enabled: boolean })[];
  /** 已核对报告的指标值（含被更正替代的旧值，函数自己跳过） */
  reportValues: readonly PlanReportValue[];
  /** 最近一段时间的监测读数 */
  readings: readonly PlanReading[];
  /** 每个方面最近一次系统计算的状态 */
  lastComputed: ReadonlyMap<TwinDomain, { level: TwinLevel; basis: unknown }>;
  /** 当前（未被替代的）预测，也就是“这批数据进来之前”的那份 */
  currentForecasts: readonly StoredForecast[];
  /** 已有跟进项引用过的数据（危急类），同一个数值不重复生成 */
  handledDataRefs: ReadonlySet<string>;
}

export interface PlannedStatus {
  domain: TwinDomain;
  level: TwinLevel;
  previousLevel: TwinLevel | null;
  basis: TwinBasisItem[];
  /** 状态（颜色或依据）有变化才写一行 */
  insert: boolean;
}

export interface PlannedForecast {
  metric: string;
  source: 'report' | 'monitoring';
  result: ForecastResult;
  /** 写入前标为被替代的旧预测 */
  supersedeId: string | null;
}

export interface PlannedFollowUp {
  kind: FollowUpKind;
  severity: FollowUpSeverity;
  domain: TwinDomain | null;
  metric: string | null;
  dedupeKey: string;
  basis: Record<string, unknown>;
  sourceRef: Record<string, unknown>;
}

export interface TwinPlan {
  rulesVersion: number;
  statuses: PlannedStatus[];
  forecasts: PlannedForecast[];
  followUps: PlannedFollowUp[];
}

function stable(v: unknown): string {
  return JSON.stringify(v);
}

/** 键按字母排序后再序列化：jsonb 读回来的键顺序和写入时不同 */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      );
    return x;
  };
  return JSON.stringify(sort(v));
}

/** 预测结果是否变了：按固定的字段顺序比较（数据库读回来的 JSON 键顺序可能不同） */
export function forecastFingerprint(r: ForecastResult): string {
  return stable([
    r.methodVersion,
    r.status,
    r.insufficientReason,
    r.pointsNeeded,
    r.nPoints,
    r.spanDays,
    r.horizonMonths,
    r.uncertainty,
    r.basis && [r.basis.kind, r.basis.from, r.basis.to, r.basis.anchor],
    r.points.map((p) => [p.monthsAhead, p.date, p.mid, p.low, p.high, p.clipped]),
  ]);
}

function catalogRef(metric: string): { low: number | null; high: number | null } {
  const def = MONITORING_METRICS.find((m) => m.code === metric) as
    { refLow?: number; refHigh?: number } | undefined;
  return { low: def?.refLow ?? null, high: def?.refHigh ?? null };
}

/** 数值能否参与判断：单位跟目录、在合理范围内 */
function usable(metric: string, value: number, unit: string): boolean {
  const bounds = THRESHOLD_BOUNDS[metric as IndicatorCode];
  if (!bounds) return false;
  return (
    unit === indicatorUnit(metric as IndicatorCode) &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max
  );
}

export function planTwinUpdate(input: PlanInput): TwinPlan {
  const nowMs = Date.parse(input.now);
  const batch = isBatchTwinTrigger(input.trigger);

  // ---------- 状态（4.2） ----------
  const evaluated = evaluateTwinStatus({
    rules: input.rules,
    rulesVersion: input.rulesVersion,
    criticalRules: input.criticalRules,
    reportValues: input.reportValues,
    readings: input.readings,
    now: input.now,
  });
  const statuses: PlannedStatus[] = evaluated.map((s) => {
    const prev = input.lastComputed.get(s.domain);
    const insert =
      !prev || prev.level !== s.level || canonicalJson(prev.basis) !== canonicalJson(s.basis);
    return {
      domain: s.domain,
      level: s.level,
      previousLevel: prev?.level ?? null,
      basis: s.basis,
      insert,
    };
  });

  // ---------- 预测（第六节）：规则、阈值修改的批量重算不涉及预测 ----------
  const forecasts: PlannedForecast[] = [];
  const current = new Map(
    input.currentForecasts.map((f) => [`${f.result.source}:${f.result.metric}`, f]),
  );
  if (input.trigger !== 'rules_changed' && input.trigger !== 'thresholds_changed') {
    const since = nowMs - (FORECAST_MONITORING_WINDOW_WEEKS * 7 + 7) * DAY_MS;
    for (const metric of FORECAST_METRICS) {
      const reportObs = input.reportValues
        .filter((v) => v.metric === metric)
        .map((v) => ({
          at: v.reportDate,
          value: v.value,
          unit: v.unit,
          supersededBy: v.supersededBy ?? null,
        }));
      const monitoringObs = input.readings
        .filter((r) => r.metric === metric && Date.parse(r.measuredAt) >= since)
        .map((r) => ({ at: r.measuredAt, value: r.value, unit: r.unit }));
      for (const [source, observations] of [
        ['report', reportObs],
        ['monitoring', monitoringObs],
      ] as const) {
        const existing = current.get(`${source}:${metric}`);
        if (observations.length === 0 && !existing) continue;
        const result = forecastMetric({ metric, source, observations, now: input.now });
        if (existing && forecastFingerprint(existing.result) === forecastFingerprint(result))
          continue;
        forecasts.push({ metric, source, result, supersedeId: existing?.id ?? null });
      }
    }
  }

  // ---------- 跟进项（2.6）：批量重算不生成（Q22） ----------
  const followUps: PlannedFollowUp[] = [];
  if (!batch) {
    followUps.push(...criticalFollowUps(input, nowMs));
    for (const s of statuses) {
      if (!s.insert || s.previousLevel === s.level) continue;
      const items = s.basis
        .filter((b) => b.outcome !== 'green')
        .map((b) => ({
          metric: b.metric,
          source: b.source,
          value: b.value,
          unit: b.unit,
          observedOn: b.observedOn,
          outcome: b.outcome,
        }));
      const basis = { domain: s.domain, from: s.previousLevel, to: s.level, items };
      if (s.level === 'red' && s.previousLevel !== 'red') {
        followUps.push({
          kind: 'status_red',
          severity: 2,
          domain: s.domain,
          metric: null,
          dedupeKey: `status_red:${s.domain}`,
          basis,
          sourceRef: {},
        });
      } else if (s.previousLevel === 'green' && s.level === 'yellow') {
        followUps.push({
          kind: 'status_worsened',
          severity: 3,
          domain: s.domain,
          metric: null,
          dedupeKey: `status_worsened:${s.domain}`,
          basis,
          sourceRef: {},
        });
      }
    }
    followUps.push(...deviationFollowUps(input, nowMs));
  }

  return { rulesVersion: input.rulesVersion, statuses, forecasts, followUps };
}

/**
 * 危急指标（2.6）：每个指标在每个来源里取最近一次数值（报告：最近一份已核对报告；
 * 监测：最近 7 天内最近一条），命中启用的 M1 危急阈值就生成，urgent 为 1 级、attention 为 2 级。
 * 已经有跟进项引用过的同一个数值不再生成（处理完以后不会因为别的数据进来又冒出来）。
 */
function criticalFollowUps(input: PlanInput, nowMs: number): PlannedFollowUp[] {
  const out: PlannedFollowUp[] = [];
  const latestReport = new Map<string, PlanReportValue>();
  for (const v of input.reportValues) {
    if (v.supersededBy) continue;
    const cur = latestReport.get(v.metric);
    if (
      !cur ||
      v.reportDate > cur.reportDate ||
      (v.reportDate === cur.reportDate && v.createdAt >= cur.createdAt)
    )
      latestReport.set(v.metric, v);
  }
  const latestReading = new Map<string, PlanReading>();
  for (const r of input.readings) {
    const t = Date.parse(r.measuredAt);
    if (t > nowMs || t <= nowMs - TWIN_MONITORING_WINDOW_DAYS * DAY_MS) continue;
    const cur = latestReading.get(r.metric);
    if (!cur || t >= Date.parse(cur.measuredAt)) latestReading.set(r.metric, r);
  }

  const candidates = [
    ...[...latestReport.values()].map((v) => ({
      source: 'report' as const,
      metric: v.metric,
      value: v.value,
      unit: v.unit,
      observedOn: v.reportDate,
      dataRef: `report_indicator:${v.indicatorId}`,
      sourceRef: { reportIndicatorId: v.indicatorId, reportId: v.reportId },
    })),
    ...[...latestReading.values()].map((r) => ({
      source: 'monitoring' as const,
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      observedOn: r.measuredAt.slice(0, 10),
      dataRef: `monitoring_reading:${r.id}`,
      sourceRef: { monitoringReadingIds: [r.id] },
    })),
  ];
  for (const c of candidates) {
    if (!usable(c.metric, c.value, c.unit)) continue;
    if (input.handledDataRefs.has(c.dataRef)) continue;
    const hits = input.criticalRules.filter(
      (r) => r.enabled && r.metric === c.metric && matchesRule(r, c.value),
    );
    if (hits.length === 0) continue;
    const top = hits.find((h) => h.level === 'urgent') ?? hits[0]!;
    out.push({
      kind: 'critical',
      severity: top.level === 'urgent' ? 1 : 2,
      domain: domainOfMetric(c.source, c.metric),
      metric: c.metric,
      dedupeKey: `critical:${c.source}:${c.metric}`,
      basis: {
        source: c.source,
        metric: c.metric,
        value: c.value,
        unit: c.unit,
        observedOn: c.observedOn,
        rule: { comparator: top.comparator, value: top.value, level: top.level },
      },
      sourceRef: { dataRef: c.dataRef, ...c.sourceRef },
    });
  }
  return out;
}

/**
 * 偏离预测（6.4，Q11）：用这批数据进来之前的那份预测（currentForecasts），看新数据是否落在区间之外。
 * - 报告指标：预测之后写入的已核对数值，按报告日期判断，取最近的一次偏离；
 * - 监测指标：含有预测之后写入的读数的有效周，取最近一周的周平均判断（单条读数不判断）；
 * - 不确定性高、数据不足的预测不判断（isDeviation 处理）。
 * 偏向变差 3 级、偏向变好 4 级；指标没有参考范围、分不出方向时按 3 级。
 */
function deviationFollowUps(input: PlanInput, nowMs: number): PlannedFollowUp[] {
  const out: PlannedFollowUp[] = [];
  for (const f of input.currentForecasts) {
    const { metric, source } = f.result;
    if (f.result.status !== 'ok' || f.result.uncertainty !== 'normal') continue;
    const sinceMs = Date.parse(f.computedAt);
    let observation:
      | {
          at: string;
          value: number;
          observedOn: string;
          ref: { low: number | null; high: number | null };
        }
      | undefined;
    let sourceRef: Record<string, unknown> = {};

    if (source === 'report') {
      const fresh = input.reportValues
        .filter(
          (v) =>
            v.metric === metric &&
            !v.supersededBy &&
            Date.parse(v.createdAt) > sinceMs &&
            usable(metric, v.value, v.unit),
        )
        .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
      for (const v of fresh) {
        const r = isDeviation(
          f.result,
          { at: v.reportDate, value: v.value },
          {
            low: v.refLow,
            high: v.refHigh,
          },
        );
        if (r.judged && r.deviated) {
          observation = {
            at: v.reportDate,
            value: v.value,
            observedOn: v.reportDate,
            ref: { low: v.refLow, high: v.refHigh },
          };
          sourceRef = { reportIndicatorId: v.indicatorId, reportId: v.reportId };
          break;
        }
      }
    } else {
      const readings = input.readings.filter(
        (r) => r.metric === metric && usable(metric, r.value, r.unit),
      );
      const freshWeeks = new Set(
        readings
          .filter((r) => Date.parse(r.createdAt) > sinceMs && Date.parse(r.measuredAt) <= nowMs)
          .map((r) => Math.floor((nowMs - Date.parse(r.measuredAt)) / (7 * DAY_MS))),
      );
      const weeks = weeklyAverages(
        readings.map((r) => ({ at: r.measuredAt, value: r.value })),
        input.now,
      )
        .filter((w) => freshWeeks.has(w.weekIndex))
        .sort((a, b) => a.weekIndex - b.weekIndex);
      const week = weeks[0];
      if (week) {
        const at = new Date(week.midAt).toISOString();
        observation = { at, value: week.average, observedOn: week.to, ref: catalogRef(metric) };
        const ids = readings
          .filter((r) => {
            const idx = Math.floor((nowMs - Date.parse(r.measuredAt)) / (7 * DAY_MS));
            return idx === week.weekIndex;
          })
          .map((r) => r.id);
        sourceRef = { monitoringReadingIds: ids, weekFrom: week.from, weekTo: week.to };
      }
    }
    if (!observation) continue;
    const r = isDeviation(
      f.result,
      { at: observation.at, value: observation.value },
      observation.ref,
    );
    if (!r.judged || !r.deviated) continue;
    out.push({
      kind: 'forecast_deviation',
      severity: r.direction === 'better' ? 4 : 3,
      domain: domainOfMetric(source, metric),
      metric,
      dedupeKey: `forecast_deviation:${source}:${metric}`,
      basis: {
        source,
        metric,
        value: observation.value,
        unit: indicatorUnit(metric as IndicatorCode),
        observedOn: observation.observedOn,
        expected: r.expected,
        side: r.side,
        direction: r.direction,
        methodVersion: f.result.methodVersion,
        intervalLevel: f.result.intervalLevel,
      },
      sourceRef: { forecastId: f.id, ...sourceRef },
    });
  }
  return out;
}

/** 每个方面包含的指标里，最近一次有新数据写入的时间（手动调整“到下次有新数据时失效”用） */
export function latestDomainDataAt(
  reportCreated: ReadonlyMap<string, number>,
  readingCreated: ReadonlyMap<string, number>,
  domainMetricsMap: Record<
    TwinDomain,
    { report: readonly string[]; monitoring: readonly string[] }
  >,
): Map<TwinDomain, number> {
  const out = new Map<TwinDomain, number>();
  for (const d of TWIN_DOMAINS) {
    let latest = 0;
    for (const m of domainMetricsMap[d].report)
      latest = Math.max(latest, reportCreated.get(m) ?? 0);
    for (const m of domainMetricsMap[d].monitoring)
      latest = Math.max(latest, readingCreated.get(m) ?? 0);
    out.set(d, latest);
  }
  return out;
}
