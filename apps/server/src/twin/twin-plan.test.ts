import {
  DEFAULT_CRITICAL_RULES,
  DEFAULT_TWIN_STATUS_RULES,
  forecastMetric,
  indicatorUnit,
  type IndicatorCode,
  type TwinDomain,
  type TwinLevel,
} from '@health-buddy/shared';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  planTwinUpdate,
  type PlanInput,
  type PlanReading,
  type PlanReportValue,
  type StoredForecast,
} from './twin-plan.js';

const NOW = '2026-10-18T08:00:00.000Z';
const DAY = 86_400_000;
const at = (daysAgo: number, hour = 7) =>
  new Date(Date.parse(NOW) - daysAgo * DAY + (hour - 8) * 3600_000).toISOString();

function reading(
  id: string,
  metric: string,
  value: number,
  daysAgo: number,
  createdDaysAgo = daysAgo,
) {
  const unit = indicatorUnit(metric as IndicatorCode);
  return { id, metric, value, unit, measuredAt: at(daysAgo), createdAt: at(createdDaysAgo) };
}

function report(
  id: string,
  metric: string,
  value: number,
  reportDate: string,
  extra: Partial<PlanReportValue> = {},
): PlanReportValue {
  return {
    indicatorId: id,
    reportId: `r-${id}`,
    metric,
    value,
    unit: indicatorUnit(metric as IndicatorCode),
    reportDate,
    refLow: null,
    refHigh: null,
    abnormal: 'no_reference',
    createdAt: `${reportDate}T10:00:00.000Z`,
    ...extra,
  };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    now: NOW,
    trigger: 'monitoring',
    rules: DEFAULT_TWIN_STATUS_RULES.map((r, i) => ({ ...r, id: `rule-${i}`, enabled: true })),
    rulesVersion: 3,
    criticalRules: DEFAULT_CRITICAL_RULES.map((r) => ({ ...r, enabled: true })),
    reportValues: [],
    readings: [],
    lastComputed: new Map(),
    currentForecasts: [],
    handledDataRefs: new Set(),
    ...over,
  };
}

function last(entries: [TwinDomain, TwinLevel, unknown?][]) {
  return new Map(entries.map(([d, level, basis]) => [d, { level, basis: basis ?? [] }]));
}

/** 26 周、每天一条的平稳读数（预测“一般”不确定性） */
function steadyWeeks(metric: string, base: number, createdDaysAgo = 200): PlanReading[] {
  const out: PlanReading[] = [];
  for (let d = 181; d >= 7; d--) {
    const wobble = ((d * 7) % 5) - 2;
    out.push(reading(`s${d}`, metric, base + wobble * 0.5, d, createdDaysAgo));
  }
  return out;
}

describe('孪生计算计划（纯函数）', () => {
  it('第一次计算：五个方面都写一行；没有数据的方面是灰色，不生成跟进项', () => {
    const plan = planTwinUpdate(input());
    expect(plan.statuses.map((s) => [s.domain, s.level, s.insert])).toEqual([
      ['metabolic', 'unknown', true],
      ['cardiovascular', 'unknown', true],
      ['sleep', 'unknown', true],
      ['weight', 'unknown', true],
      ['mental', 'unknown', true],
    ]);
    expect(plan.followUps).toEqual([]);
    expect(plan.rulesVersion).toBe(3);
  });

  it('状态和依据都没变时不写；依据从数据库读回来键顺序不同也算没变', () => {
    const first = planTwinUpdate(input({ readings: [reading('1', 'sbp', 120, 1)] }));
    const cardio = first.statuses.find((s) => s.domain === 'cardiovascular')!;
    expect(cardio.level).toBe('green');
    // 模拟 jsonb：键顺序打乱
    const reordered = JSON.parse(canonicalJson(cardio.basis)) as unknown;
    const second = planTwinUpdate(
      input({
        readings: [reading('1', 'sbp', 120, 1)],
        lastComputed: last([
          ['metabolic', 'unknown'],
          ['cardiovascular', 'green', reordered],
          ['sleep', 'unknown'],
          ['weight', 'unknown'],
          ['mental', 'unknown'],
        ]),
      }),
    );
    expect(second.statuses.filter((s) => s.insert)).toEqual([]);
  });

  it('由非红变红生成“状态变红”（2 级），由绿变黄生成“状态变差”（3 级），由黄变绿不生成', () => {
    const red = planTwinUpdate(
      input({
        readings: [reading('9', 'sbp', 185, 0.5)],
        lastComputed: last([['cardiovascular', 'yellow']]),
      }),
    );
    expect(red.followUps.map((f) => [f.kind, f.severity, f.dedupeKey])).toEqual([
      ['critical', 1, 'critical:monitoring:sbp'],
      ['status_red', 2, 'status_red:cardiovascular'],
    ]);

    const worse = planTwinUpdate(
      input({
        reportValues: [
          report('i1', 'fpg', 6.5, '2026-10-10', { refLow: 3.9, refHigh: 6.1, abnormal: 'high' }),
        ],
        lastComputed: last([['metabolic', 'green']]),
        trigger: 'report_verified',
      }),
    );
    expect(worse.followUps.map((f) => [f.kind, f.severity, f.domain])).toEqual([
      ['status_worsened', 3, 'metabolic'],
    ]);
    // 依据写明指标、数值、日期
    expect(worse.followUps[0]!.basis).toMatchObject({
      from: 'green',
      to: 'yellow',
      items: [{ metric: 'fpg', value: 6.5, observedOn: '2026-10-10', source: 'report' }],
    });

    const better = planTwinUpdate(
      input({
        readings: [reading('1', 'sbp', 120, 1)],
        lastComputed: last([['cardiovascular', 'yellow']]),
      }),
    );
    expect(better.followUps).toEqual([]);
  });

  it('规则、阈值修改和补算是批量重算：状态照常写，不生成任何跟进项，规则修改不重算预测', () => {
    for (const trigger of ['rules_changed', 'thresholds_changed', 'backfill'] as const) {
      const plan = planTwinUpdate(
        input({
          trigger,
          readings: [reading('9', 'sbp', 185, 0.5), ...steadyWeeks('weight', 70)],
          lastComputed: last([['cardiovascular', 'green']]),
        }),
      );
      expect(plan.statuses.find((s) => s.domain === 'cardiovascular')).toMatchObject({
        level: 'red',
        insert: true,
      });
      expect(plan.followUps, trigger).toEqual([]);
      expect(plan.forecasts.length > 0, trigger).toBe(trigger === 'backfill');
    }
  });

  it('危急指标：同一个数值已有跟进项引用过就不再生成；attention 为 2 级', () => {
    const r = reading('77', 'sbp', 185, 0.2);
    const handled = planTwinUpdate(
      input({ readings: [r], handledDataRefs: new Set(['monitoring_reading:77']) }),
    );
    expect(handled.followUps.filter((f) => f.kind === 'critical')).toEqual([]);

    const attention = planTwinUpdate(
      input({ reportValues: [report('u1', 'uric_acid', 600, '2026-10-01')] }),
    );
    const item = attention.followUps.find((f) => f.kind === 'critical')!;
    expect(item).toMatchObject({ severity: 2, metric: 'uric_acid', domain: 'metabolic' });
    expect(item.sourceRef).toMatchObject({ dataRef: 'report_indicator:u1' });
  });

  it('预测：有新数据的指标写新预测并替代旧的；结果没变时不写', () => {
    const readings = steadyWeeks('weight', 70);
    const plan = planTwinUpdate(input({ readings }));
    const weight = plan.forecasts.find((f) => f.metric === 'weight' && f.source === 'monitoring')!;
    expect(weight.result.status).toBe('ok');
    expect(weight.supersedeId).toBeNull();

    const stored: StoredForecast = { id: 'f1', computedAt: at(1), result: weight.result };
    const again = planTwinUpdate(input({ readings, currentForecasts: [stored] }));
    expect(again.forecasts.filter((f) => f.metric === 'weight')).toEqual([]);
  });

  describe('偏离预测（6.4）', () => {
    // 预测在 30 天前算出（只用到 30 天前的数据），之后进来一周明显偏高的读数
    const history = steadyWeeks('weight', 70, 200).filter(
      (r) => Date.parse(r.measuredAt) < Date.parse(at(30)),
    );
    const past = new Date(Date.parse(NOW) - 30 * DAY).toISOString();
    const forecast = forecastMetric({
      metric: 'weight',
      source: 'monitoring',
      observations: history.map((r) => ({ at: r.measuredAt, value: r.value, unit: r.unit })),
      now: past,
    });
    const stored: StoredForecast = { id: 'f-old', computedAt: past, result: forecast };
    const spike = [0, 1, 2, 3].map((d) => reading(`n${d}`, 'weight', 90, d + 0.2, 0));

    it('新的有效周平均落在“数据进来之前”那份预测的区间之外：生成偏离（没有参考范围按 3 级）', () => {
      expect(forecast.status).toBe('ok');
      expect(forecast.uncertainty).toBe('normal');
      const plan = planTwinUpdate(
        input({ readings: [...history, ...spike], currentForecasts: [stored] }),
      );
      const dev = plan.followUps.find((f) => f.kind === 'forecast_deviation')!;
      expect(dev).toMatchObject({
        severity: 3,
        metric: 'weight',
        domain: 'weight',
        dedupeKey: 'forecast_deviation:monitoring:weight',
      });
      expect(dev.sourceRef).toMatchObject({ forecastId: 'f-old' });
      expect(dev.basis).toMatchObject({ value: 90, side: 'above' });
    });

    it('单条读数（不够一个有效周）不判断', () => {
      const plan = planTwinUpdate(
        input({ readings: [...history, spike[0]!], currentForecasts: [stored] }),
      );
      expect(plan.followUps.filter((f) => f.kind === 'forecast_deviation')).toEqual([]);
    });

    it('不确定性高的预测不判断', () => {
      const high: StoredForecast = { ...stored, result: { ...forecast, uncertainty: 'high' } };
      const plan = planTwinUpdate(
        input({ readings: [...history, ...spike], currentForecasts: [high] }),
      );
      expect(plan.followUps.filter((f) => f.kind === 'forecast_deviation')).toEqual([]);
    });

    it('预测之前就有的数据不算新数据', () => {
      const old = spike.map((r) => ({ ...r, createdAt: at(40) }));
      const plan = planTwinUpdate(
        input({ readings: [...history, ...old], currentForecasts: [stored] }),
      );
      expect(plan.followUps.filter((f) => f.kind === 'forecast_deviation')).toEqual([]);
    });

    it('报告指标：新核对的数值偏向参考范围外为变差（3 级），偏向范围内为变好（4 级）', () => {
      const reports = [
        report('a', 'fpg', 5.0, '2025-01-10'),
        report('b', 'fpg', 5.4, '2025-07-10'),
        report('c', 'fpg', 5.6, '2025-10-10'),
        report('d', 'fpg', 6.0, '2026-04-10'),
      ];
      const f = forecastMetric({
        metric: 'fpg',
        source: 'report',
        observations: reports.map((r) => ({ at: r.reportDate, value: r.value, unit: r.unit })),
        now: '2026-05-01T00:00:00Z',
      });
      expect(f.uncertainty).toBe('normal');
      const s: StoredForecast = { id: 'f-fpg', computedAt: '2026-05-01T00:00:00.000Z', result: f };
      const ref = { refLow: 3.9, refHigh: 6.1 };
      const worse = planTwinUpdate(
        input({
          trigger: 'report_verified',
          reportValues: [
            ...reports,
            report('e', 'fpg', 9.5, '2026-07-10', { ...ref, abnormal: 'high' }),
          ],
          currentForecasts: [s],
        }),
      );
      expect(worse.followUps.find((x) => x.kind === 'forecast_deviation')).toMatchObject({
        severity: 3,
        basis: { direction: 'worse' },
      });
      const better = planTwinUpdate(
        input({
          trigger: 'report_verified',
          reportValues: [
            ...reports,
            report('e', 'fpg', 4.2, '2026-07-10', { ...ref, abnormal: 'normal' }),
          ],
          currentForecasts: [s],
        }),
      );
      expect(better.followUps.find((x) => x.kind === 'forecast_deviation')).toMatchObject({
        severity: 4,
        basis: { direction: 'better' },
      });
    });
  });
});
