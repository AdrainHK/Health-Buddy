import { describe, expect, it } from 'vitest';
import {
  FORECAST_METHOD_VERSION,
  FORECAST_METRICS,
  FORECAST_WIDE_INTERVAL,
  fitLine,
  forecastMetric,
  isDeviation,
  predictAt,
  tQuantile90,
  weeklyAverages,
  type ForecastObservation,
} from './forecast.js';
import { THRESHOLD_BOUNDS } from './critical.js';

const NOW = '2026-10-18T08:00:00Z';
const DAY = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
const rep = (at: string, value: number, unit = 'mmHg'): ForecastObservation => ({
  at,
  value,
  unit,
});

/** 往前 weeks 周、每周 perWeek 条读数，数值由 valueAt(距今天数) 给出 */
function dailyReadings(
  weeks: number,
  perWeek: number,
  valueAt: (daysAgo: number) => number,
  unit = 'mmHg',
): ForecastObservation[] {
  const out: ForecastObservation[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let k = 0; k < perWeek; k++) {
      const daysAgo = w * 7 + k + 0.25;
      out.push({
        at: new Date(Date.parse(NOW) - daysAgo * DAY).toISOString(),
        value: valueAt(daysAgo),
        unit,
      });
    }
  }
  return out;
}

describe('最小二乘直线拟合和 80% 区间（对照手算）', () => {
  it('拟合 (0,1)(1,3)(2,2)(3,4)', () => {
    const fit = fitLine([0, 1, 2, 3], [1, 3, 2, 4])!;
    // 手算：x̄=1.5，ȳ=2.5，Sxx=5，Sxy=4 → 斜率 0.8，截距 1.3；SSE=1.8，s=√0.9
    expect(fit.slope).toBeCloseTo(0.8, 10);
    expect(fit.intercept).toBeCloseTo(1.3, 10);
    expect(fit.sxx).toBe(5);
    expect(fit.residualSd).toBeCloseTo(Math.sqrt(0.9), 10);
    // x=5：中间值 5.3；半宽 = t(0.9,2)=1.886 × √0.9 × √(1 + 1/4 + 3.5²/5) = 3.4416
    const p = predictAt(fit, 5);
    expect(p.mid).toBeCloseTo(5.3, 10);
    expect(p.high - p.mid).toBeCloseTo(1.886 * Math.sqrt(0.9) * Math.sqrt(3.7), 10);
    expect(p.low).toBeCloseTo(1.8584, 3);
    expect(p.high).toBeCloseTo(8.7416, 3);
  });

  it('点数不足或 x 全相同时不拟合', () => {
    expect(fitLine([0, 1], [1, 2])).toBeNull();
    expect(fitLine([2, 2, 2], [1, 2, 3])).toBeNull();
  });

  it('t 分布分位数：查表和大自由度近似', () => {
    expect(tQuantile90(1)).toBe(3.078);
    expect(tQuantile90(2)).toBe(1.886);
    expect(tQuantile90(30)).toBe(1.31);
    expect(tQuantile90(40)).toBeCloseTo(1.303, 3);
    expect(tQuantile90(120)).toBeCloseTo(1.289, 3);
    expect(tQuantile90(100000)).toBeCloseTo(1.2816, 3);
    expect(Number.isNaN(tQuantile90(0))).toBe(true);
  });
});

describe('forecastMetric：报告指标', () => {
  const start = '2025-01-01';
  // 每 200 天一次，收缩压每天升 0.01
  const line = [0, 200, 400, 600].map((d, i) => rep(addDays(start, d), 130 + 2 * i));

  it('直线数据：给 3 个月和 6 个月，从最近一份报告起算，方法版本写进结果', () => {
    const f = forecastMetric({ metric: 'sbp', source: 'report', observations: line, now: NOW });
    expect(f.status).toBe('ok');
    expect(f.methodVersion).toBe(FORECAST_METHOD_VERSION);
    expect(f.intervalLevel).toBe(0.8);
    expect(f.nPoints).toBe(4);
    expect(f.spanDays).toBe(600);
    expect(f.horizonMonths).toBe(6);
    expect(f.basis).toEqual({
      kind: 'report_values',
      from: '2025-01-01',
      to: '2026-08-24',
      anchor: '2026-08-24',
    });
    // 2026-08-24 + 3 个月 = 2026-11-24（第 692 天），+6 个月 = 2027-02-24（第 784 天）
    expect(f.points).toEqual([
      {
        monthsAhead: 3,
        date: '2026-11-24',
        mid: 136.92,
        low: 136.92,
        high: 136.92,
        clipped: false,
      },
      {
        monthsAhead: 6,
        date: '2027-02-24',
        mid: 137.84,
        low: 137.84,
        high: 137.84,
        clipped: false,
      },
    ]);
    expect(f.uncertainty).toBe('normal');
  });

  it('只有 2 次：数据不足，还需要 1 次', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: line.slice(0, 2),
      now: NOW,
    });
    expect(f).toMatchObject({
      status: 'insufficient_data',
      insufficientReason: 'too_few_points',
      pointsNeeded: 1,
      nPoints: 2,
      points: [],
      horizonMonths: null,
      uncertainty: null,
    });
  });

  it('3 次但跨度不到 6 个月：不预测', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [rep('2026-04-01', 130), rep('2026-06-01', 132), rep('2026-09-20', 135)],
      now: NOW,
    });
    expect(f).toMatchObject({ status: 'insufficient_data', insufficientReason: 'span_too_short' });
  });

  it('跨度 6–11 个月只给 3 个月；刚好 12 个月给 6 个月', () => {
    const short = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [rep('2025-12-01', 130), rep('2026-03-01', 133), rep('2026-06-01', 135)],
      now: NOW,
    });
    expect(short.horizonMonths).toBe(3);
    expect(short.points.map((p) => p.monthsAhead)).toEqual([3]);
    const year = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [rep('2025-06-01', 130), rep('2025-12-01', 133), rep('2026-06-01', 135)],
      now: NOW,
    });
    expect(year.points.map((p) => p.monthsAhead)).toEqual([3, 6]);
  });

  it('刚好达到最少次数：不确定性高', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [rep('2025-06-01', 130), rep('2025-12-01', 132), rep('2026-06-01', 134)],
      now: NOW,
    });
    expect(f.status).toBe('ok');
    expect(f.uncertainty).toBe('high');
  });

  it('只用最近 24 个月的数值', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [rep('2024-06-01', 200), ...line],
      now: NOW,
    });
    expect(f.nPoints).toBe(4);
    expect(f.points[0]!.mid).toBe(136.92);
  });

  it('报告更正：被替代的值不参与', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [...line, { ...rep(addDays(start, 600), 190), supersededBy: 'new' }],
      now: NOW,
    });
    expect(f.nPoints).toBe(4);
    expect(f.points[0]!.mid).toBe(136.92);
  });

  it('单位和目录不一致的数值不参与，剩下的不够就不预测', () => {
    const f = forecastMetric({
      metric: 'fpg',
      source: 'report',
      observations: [
        rep('2025-01-01', 5.5, 'mmol/L'),
        rep('2025-08-01', 110, 'mg/dL'),
        rep('2026-06-01', 6.0, 'mmol/L'),
      ],
      now: NOW,
    });
    expect(f).toMatchObject({ status: 'insufficient_data', nPoints: 2, pointsNeeded: 1 });
  });

  it('离群值：超出合理范围的丢弃；范围内的离群值让区间变宽、不确定性变高', () => {
    const typo = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [...line, rep('2026-03-01', 1350)],
      now: NOW,
    });
    expect(typo.nPoints).toBe(4);
    expect(typo.uncertainty).toBe('normal');

    const noisy = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [...line, rep('2026-03-01', 175)],
      now: NOW,
    });
    expect(noisy.nPoints).toBe(5);
    const six = noisy.points[1]!;
    expect(six.high - six.low).toBeGreaterThan(FORECAST_WIDE_INTERVAL.sbp);
    expect(noisy.uncertainty).toBe('high');
  });

  it('结果截在合理范围内（不会算出负的步数）', () => {
    const f = forecastMetric({
      metric: 'weight',
      source: 'report',
      observations: [
        rep('2025-01-01', 80, 'kg'),
        rep('2025-07-01', 50, 'kg'),
        rep('2026-01-01', 21, 'kg'),
      ],
      now: NOW,
    });
    expect(f.status).toBe('ok');
    for (const p of f.points) {
      expect(p.low).toBeGreaterThanOrEqual(THRESHOLD_BOUNDS.weight.min);
      expect(p.mid).toBeGreaterThanOrEqual(THRESHOLD_BOUNDS.weight.min);
    }
    expect(f.points.some((p) => p.clipped)).toBe(true);
  });

  it('不在预测目录里的指标（肝肾功能）不预测', () => {
    expect(FORECAST_METRICS).not.toContain('alt');
    const f = forecastMetric({
      metric: 'alt',
      source: 'report',
      observations: line.map((o) => ({ ...o, unit: 'U/L' })),
      now: NOW,
    });
    expect(f).toMatchObject({
      status: 'insufficient_data',
      insufficientReason: 'not_forecastable',
    });
  });

  it('不预测未来日期的数据', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [...line.slice(0, 2), rep('2027-01-01', 150)],
      now: NOW,
    });
    expect(f).toMatchObject({ status: 'insufficient_data', nPoints: 2 });
  });
});

describe('forecastMetric：监测指标', () => {
  it('按周取平均，一周少于 3 条不算有效周', () => {
    const weeks = weeklyAverages(
      [
        ...dailyReadings(2, 3, () => 120).map((o) => ({ at: o.at, value: o.value })),
        { at: new Date(Date.parse(NOW) - 15 * DAY).toISOString(), value: 200 },
        { at: new Date(Date.parse(NOW) - 16 * DAY).toISOString(), value: 200 },
      ],
      NOW,
    );
    expect(weeks.map((w) => [w.weekIndex, w.average, w.count])).toEqual([
      [1, 120, 3],
      [0, 120, 3],
    ]);
    expect(weeks[1]!.to).toBe('2026-10-18');
  });

  it('不到 8 个有效周：数据不足，还需要几周', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'monitoring',
      observations: dailyReadings(7, 4, () => 130),
      now: NOW,
    });
    expect(f).toMatchObject({
      status: 'insufficient_data',
      insufficientReason: 'too_few_points',
      nPoints: 7,
      pointsNeeded: 1,
    });
  });

  it('8 个有效周但只覆盖 8 周：预测时长不能超过数据跨度，不预测', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'monitoring',
      observations: dailyReadings(8, 4, () => 130),
      now: NOW,
    });
    expect(f).toMatchObject({
      status: 'insufficient_data',
      insufficientReason: 'span_too_short',
      nPoints: 8,
      spanDays: 56,
    });
  });

  it('13 周：只给 3 个月，从最近一周起算', () => {
    const f = forecastMetric({
      metric: 'sbp',
      source: 'monitoring',
      observations: dailyReadings(13, 4, (d) => 140 - d * 0.05),
      now: NOW,
    });
    expect(f.status).toBe('ok');
    expect(f.nPoints).toBe(13);
    expect(f.spanDays).toBe(91);
    expect(f.points.map((p) => p.monthsAhead)).toEqual([3]);
    expect(f.basis?.kind).toBe('weekly_averages');
    // 每天升 0.05 mmHg，3 个月后中间值应在 140 + 0.05×(92+3.5) 附近
    expect(f.points[0]!.mid).toBeGreaterThan(144);
    expect(f.points[0]!.mid).toBeLessThan(145.5);
  });

  it('26 个有效周：给 3 个月和 6 个月', () => {
    const f = forecastMetric({
      metric: 'weight',
      source: 'monitoring',
      observations: dailyReadings(26, 5, (d) => 70 + (d % 3) * 0.2, 'kg'),
      now: NOW,
    });
    expect(f.status).toBe('ok');
    expect(f.points.map((p) => p.monthsAhead)).toEqual([3, 6]);
    expect(f.uncertainty).toBe('normal');
  });

  it('单条读数异常不影响有效周的判断，只是拉动周平均', () => {
    const obs = dailyReadings(26, 5, () => 72, 'kg');
    obs.push({ at: new Date(Date.parse(NOW) - 3 * DAY).toISOString(), value: 400, unit: 'kg' });
    const f = forecastMetric({
      metric: 'weight',
      source: 'monitoring',
      observations: obs,
      now: NOW,
    });
    // 400 kg 超出合理范围，丢弃；其余数据完全平稳
    expect(f.points[1]).toMatchObject({ mid: 72, low: 72, high: 72 });
  });
});

describe('isDeviation：偏离预测', () => {
  const line = [0, 200, 400, 600].map((d, i) =>
    rep(addDays('2025-01-01', d), 130 + 2 * i + (i % 2 ? 1 : -1)),
  );
  const f = forecastMetric({ metric: 'sbp', source: 'report', observations: line, now: NOW });
  const ref = { low: null, high: 140 };

  it('落在区间内：不算偏离', () => {
    const r = isDeviation(f, { at: '2026-11-24', value: f.points[0]!.mid }, ref);
    expect(r).toMatchObject({ judged: true, deviated: false });
  });

  it('高于区间、离参考范围更远：偏向变差', () => {
    const r = isDeviation(f, { at: '2026-11-24', value: 170 }, ref);
    expect(r).toMatchObject({ judged: true, deviated: true, side: 'above', direction: 'worse' });
  });

  it('低于区间：偏向变好', () => {
    const r = isDeviation(f, { at: '2026-11-24', value: 110 }, ref);
    expect(r).toMatchObject({ judged: true, deviated: true, side: 'below', direction: 'better' });
  });

  it('只有下限的指标（如 HDL-C）：低于区间算变差', () => {
    const hdl = forecastMetric({
      metric: 'hdl_c',
      source: 'report',
      observations: [
        rep('2025-01-01', 1.2, 'mmol/L'),
        rep('2025-06-01', 1.25, 'mmol/L'),
        rep('2025-11-01', 1.18, 'mmol/L'),
        rep('2026-06-01', 1.22, 'mmol/L'),
      ],
      now: NOW,
    });
    const r = isDeviation(hdl, { at: '2026-08-01', value: 0.6 }, { low: 1.0, high: null });
    expect(r).toMatchObject({ deviated: true, direction: 'worse' });
  });

  it('指标没有参考范围：方向未知', () => {
    const r = isDeviation(f, { at: '2026-11-24', value: 170 });
    expect(r).toMatchObject({ deviated: true, direction: 'unknown' });
  });

  it('不确定性高、数据不足、超出预测时段的不判断', () => {
    const minimal = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: line.slice(1),
      now: NOW,
    });
    expect(minimal.uncertainty).toBe('high');
    expect(isDeviation(minimal, { at: '2026-11-24', value: 200 })).toEqual({
      judged: false,
      reason: 'high_uncertainty',
    });
    const none = forecastMetric({ metric: 'sbp', source: 'report', observations: [], now: NOW });
    expect(isDeviation(none, { at: '2026-11-24', value: 200 })).toEqual({
      judged: false,
      reason: 'insufficient',
    });
    // 预测起点当天及以前、最远预测点之后
    expect(isDeviation(f, { at: '2026-08-24', value: 200 })).toMatchObject({ judged: false });
    expect(isDeviation(f, { at: '2027-03-01', value: 200 })).toMatchObject({
      judged: false,
      reason: 'outside_horizon',
    });
  });
});
