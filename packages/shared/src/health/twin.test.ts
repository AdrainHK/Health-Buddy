import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITICAL_RULES, THRESHOLD_BOUNDS } from './critical.js';
import {
  DEFAULT_TWIN_STATUS_RULES,
  TWIN_DOMAINS,
  addMonthsIso,
  domainMetrics,
  domainOfMetric,
  evaluateDomainStatus,
  evaluateTwinStatus,
  twinRuleShapeError,
  worstTwinLevel,
  type EvaluateTwinInput,
  type TwinMonitoringReading,
  type TwinReportValue,
  type TwinStatusRule,
} from './twin.js';

const NOW = '2026-10-18T08:00:00Z';
const RULES: TwinStatusRule[] = DEFAULT_TWIN_STATUS_RULES.map((r, i) => ({
  ...r,
  id: `rule-${i}`,
  enabled: true,
}));

let seq = 0;
function report(
  metric: string,
  value: number,
  reportDate: string,
  extra: Partial<TwinReportValue> = {},
): TwinReportValue {
  seq++;
  const units: Record<string, string> = {
    fpg: 'mmol/L',
    sbp: 'mmHg',
    dbp: 'mmHg',
    uric_acid: 'umol/L',
    weight: 'kg',
    bmi: 'kg/m2',
    tc: 'mmol/L',
    hdl_c: 'mmol/L',
  };
  return {
    indicatorId: `ind-${seq}`,
    reportId: `rep-${reportDate}`,
    metric,
    value,
    unit: units[metric] ?? '',
    reportDate,
    refLow: null,
    refHigh: null,
    abnormal: 'normal',
    ...extra,
  };
}

/** 从 NOW 往前 daysAgo 天的读数 */
function reading(
  metric: string,
  value: number,
  daysAgo: number,
  unit?: string,
): TwinMonitoringReading {
  seq++;
  const units: Record<string, string> = {
    sbp: 'mmHg',
    dbp: 'mmHg',
    heart_rate: 'bpm',
    fpg: 'mmol/L',
    weight: 'kg',
    sleep_hours: 'h',
  };
  return {
    id: `r-${seq}`,
    metric,
    value,
    unit: unit ?? units[metric] ?? '',
    measuredAt: new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString(),
  };
}

function input(over: Partial<EvaluateTwinInput>): EvaluateTwinInput {
  return {
    rules: RULES,
    rulesVersion: 3,
    criticalRules: DEFAULT_CRITICAL_RULES,
    reportValues: [],
    readings: [],
    now: NOW,
    ...over,
  };
}

describe('四个方面和默认规则', () => {
  it('每个指标在每个来源里最多属于一个方面，血脂只在代谢，肝肾不归入', () => {
    for (const source of ['report', 'monitoring'] as const) {
      const all = TWIN_DOMAINS.flatMap((d) => [...domainMetrics[d][source]]);
      expect(new Set(all).size).toBe(all.length);
    }
    expect(domainOfMetric('report', 'ldl_c')).toBe('metabolic');
    expect(domainOfMetric('report', 'alt')).toBeNull();
    expect(domainOfMetric('report', 'creatinine')).toBeNull();
    expect(domainOfMetric('monitoring', 'sleep_hours')).toBe('sleep');
    expect(domainOfMetric('monitoring', 'steps')).toBeNull();
  });

  it('默认规则全部合法，阈值落在合理范围内', () => {
    for (const r of DEFAULT_TWIN_STATUS_RULES)
      expect(twinRuleShapeError(r), JSON.stringify(r)).toBeNull();
  });

  it('默认的监测固定阈值取目录范围；睡眠、体重不设阈值', () => {
    const thresholds = DEFAULT_TWIN_STATUS_RULES.filter((r) => r.method === 'threshold').map(
      (r) => `${r.metric} ${r.comparator} ${r.value} ${r.unit} ${r.windowDays}d ${r.level}`,
    );
    expect(thresholds.sort()).toEqual(
      [
        'dbp gt 90 mmHg 7d yellow',
        'fpg gt 6.1 mmol/L 7d yellow',
        'fpg lt 3.9 mmol/L 7d yellow',
        'heart_rate gt 100 bpm 7d yellow',
        'heart_rate lt 60 bpm 7d yellow',
        'sbp gt 140 mmHg 7d yellow',
      ].sort(),
    );
    // 危急阈值两档都算红（Q2 A）；超出报告参考范围算黄
    expect(
      DEFAULT_TWIN_STATUS_RULES.filter((r) => r.method === 'critical').every(
        (r) => r.level === 'red',
      ),
    ).toBe(true);
    expect(
      DEFAULT_TWIN_STATUS_RULES.filter((r) => r.method === 'out_of_reference').every(
        (r) => r.level === 'yellow' && r.source === 'report',
      ),
    ).toBe(true);
  });

  it('规则形状校验挡住不合法的组合', () => {
    const base = {
      domain: 'cardiovascular' as const,
      metric: 'sbp' as const,
      source: 'monitoring' as const,
      method: 'threshold' as const,
      comparator: 'gt' as const,
      value: 140,
      unit: 'mmHg',
      windowDays: 7,
      level: 'yellow' as const,
    };
    expect(twinRuleShapeError(base)).toBeNull();
    expect(twinRuleShapeError({ ...base, domain: 'metabolic' })).toBe('metric not in domain');
    expect(twinRuleShapeError({ ...base, unit: 'kPa' })).toBe('unit must follow the catalog');
    expect(twinRuleShapeError({ ...base, value: 1400 })).toBe('value out of range');
    expect(twinRuleShapeError({ ...base, comparator: null })).toMatch(/needs comparator/);
    expect(twinRuleShapeError({ ...base, windowDays: null })).toMatch(/window_days/);
    expect(twinRuleShapeError({ ...base, source: 'report', windowDays: null })).toBe(
      'threshold is for monitoring',
    );
    expect(
      twinRuleShapeError({
        ...base,
        method: 'out_of_reference',
        comparator: null,
        value: null,
        unit: null,
      }),
    ).toBe('out_of_reference is for reports');
    expect(
      twinRuleShapeError({ ...base, source: 'report', method: 'critical', windowDays: null }),
    ).toBe('only threshold rules have comparator, value and unit');
  });

  it('取最严重的状态：红 > 黄 > 绿 > 灰', () => {
    expect(worstTwinLevel([])).toBe('unknown');
    expect(worstTwinLevel(['green', 'yellow'])).toBe('yellow');
    expect(worstTwinLevel(['yellow', 'red', 'green'])).toBe('red');
  });

  it('按日历加减月，月底对齐', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-10-18', -12)).toBe('2025-10-18');
    expect(addMonthsIso('2026-08-31', 6)).toBe('2027-02-28');
  });
});

describe('evaluateDomainStatus', () => {
  it('没有任何数据：四个方面都是灰（数据不足）', () => {
    const all = evaluateTwinStatus(input({}));
    expect(all.map((s) => s.level)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(all.every((s) => s.basis.length === 0 && s.rulesVersion === 3)).toBe(true);
  });

  it('空腹血糖高于报告参考范围：代谢变黄，依据写明数值、日期、参考范围和规则', () => {
    const v = report('fpg', 6.5, '2026-09-12', { refLow: 3.9, refHigh: 6.1, abnormal: 'high' });
    const s = evaluateDomainStatus('metabolic', input({ reportValues: [v] }));
    expect(s.level).toBe('yellow');
    const rule = RULES.find(
      (r) => r.metric === 'fpg' && r.source === 'report' && r.method === 'out_of_reference',
    )!;
    expect(s.basis).toEqual([
      {
        metric: 'fpg',
        source: 'report',
        value: 6.5,
        unit: 'mmol/L',
        observedOn: '2026-09-12',
        reportId: v.reportId,
        indicatorId: v.indicatorId,
        refLow: 3.9,
        refHigh: 6.1,
        noReference: false,
        outcome: 'yellow',
        hits: [
          {
            ruleId: rule.id,
            method: 'out_of_reference',
            level: 'yellow',
            snapshot: { refLow: 3.9, refHigh: 6.1, abnormal: 'high' },
          },
        ],
      },
    ]);
  });

  it('命中危急阈值（urgent 和 attention 两档）都是红，快照记下阈值和档位', () => {
    const cv = evaluateDomainStatus(
      'cardiovascular',
      input({ reportValues: [report('sbp', 185, '2026-09-01')] }),
    );
    expect(cv.level).toBe('red');
    expect(cv.basis[0]!.hits[0]).toMatchObject({
      method: 'critical',
      level: 'red',
      snapshot: { comparator: 'gte', value: 180, unit: 'mmHg', criticalLevel: 'urgent' },
    });
    const met = evaluateDomainStatus(
      'metabolic',
      input({ reportValues: [report('uric_acid', 560, '2026-09-01')] }),
    );
    expect(met.level).toBe('red');
    expect(met.basis[0]!.hits[0]).toMatchObject({ snapshot: { criticalLevel: 'attention' } });
  });

  it('危急阈值的边界：等于阈值算命中，刚好不到不算', () => {
    const at = (v: number) =>
      evaluateDomainStatus(
        'cardiovascular',
        input({ reportValues: [report('sbp', v, '2026-09-01')] }),
      ).level;
    expect(at(180)).toBe('red');
    expect(at(179.9)).toBe('green');
  });

  it('报告未提供参考范围：不按参考范围判断，但危急阈值仍然生效', () => {
    const green = evaluateDomainStatus(
      'metabolic',
      input({ reportValues: [report('tc', 7.2, '2026-09-01', { abnormal: 'no_reference' })] }),
    );
    expect(green.level).toBe('green');
    expect(green.basis[0]).toMatchObject({ noReference: true, outcome: 'green', hits: [] });
    const red = evaluateDomainStatus(
      'metabolic',
      input({ reportValues: [report('fpg', 2.8, '2026-09-01', { abnormal: 'no_reference' })] }),
    );
    expect(red.level).toBe('red');
  });

  it('只用每个指标最近一份报告的值', () => {
    const s = evaluateDomainStatus(
      'metabolic',
      input({
        reportValues: [
          report('fpg', 7.0, '2025-11-01', { refLow: 3.9, refHigh: 6.1, abnormal: 'high' }),
          report('fpg', 5.2, '2026-09-01', { refLow: 3.9, refHigh: 6.1, abnormal: 'normal' }),
        ],
      }),
    );
    expect(s.level).toBe('green');
    expect(s.basis).toHaveLength(1);
    expect(s.basis[0]!.value).toBe(5.2);
  });

  it('报告更正：被替代的值不参与，用更正后的新值', () => {
    const old = report('fpg', 7.8, '2026-09-01', { abnormal: 'high', supersededBy: 'ind-new' });
    const fixed = report('fpg', 5.6, '2026-09-01', {
      indicatorId: 'ind-new',
      refLow: 3.9,
      refHigh: 6.1,
      abnormal: 'normal',
    });
    const s = evaluateDomainStatus('metabolic', input({ reportValues: [fixed, old] }));
    expect(s.level).toBe('green');
    expect(s.basis.map((b) => b.value)).toEqual([5.6]);
  });

  it('报告数据超过 12 个月且没有近期监测：变灰，记为过期', () => {
    const s = evaluateDomainStatus(
      'metabolic',
      input({ reportValues: [report('fpg', 6.8, '2025-10-17', { abnormal: 'high' })] }),
    );
    expect(s.level).toBe('unknown');
    expect(s.skipped).toEqual([
      { metric: 'fpg', source: 'report', observedOn: '2025-10-17', reason: 'stale' },
    ]);
    // 刚好 12 个月整还不算过期
    const edge = evaluateDomainStatus(
      'metabolic',
      input({ reportValues: [report('fpg', 6.8, '2025-10-18', { abnormal: 'high' })] }),
    );
    expect(edge.level).toBe('yellow');
  });

  it('报告过期但有近期监测：按监测判断', () => {
    const s = evaluateDomainStatus(
      'metabolic',
      input({
        reportValues: [report('fpg', 6.8, '2024-05-01', { abnormal: 'high' })],
        readings: [reading('fpg', 5.4, 1), reading('fpg', 5.6, 2)],
      }),
    );
    expect(s.level).toBe('green');
    expect(s.basis.map((b) => b.source)).toEqual(['monitoring']);
  });

  it('只有监测：最近 7 天平均超出固定阈值为黄，等于阈值不算', () => {
    const avg = (values: number[]) =>
      evaluateDomainStatus(
        'cardiovascular',
        input({ readings: values.map((v, i) => reading('sbp', v, i + 0.5)) }),
      );
    expect(avg([140, 140, 140]).level).toBe('green');
    const s = avg([138, 142, 141.5]);
    expect(s.level).toBe('yellow');
    expect(s.basis[0]).toMatchObject({
      source: 'monitoring',
      value: 140.5,
      count: 3,
      windowDays: 7,
      outcome: 'yellow',
    });
    expect(s.basis[0]!.hits[0]).toMatchObject({
      method: 'threshold',
      snapshot: {
        comparator: 'gt',
        value: 140,
        unit: 'mmHg',
        windowDays: 7,
        average: 140.5,
        count: 3,
      },
    });
  });

  it('静息心率平均低于 60 为黄', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({ readings: [reading('heart_rate', 56, 1), reading('heart_rate', 58, 2)] }),
    );
    expect(s.level).toBe('yellow');
  });

  it('7 天以前的读数不算近期数据', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({ readings: [reading('sbp', 150, 8), reading('sbp', 150, 10)] }),
    );
    expect(s.level).toBe('unknown');
  });

  it('监测的危急阈值看窗口内最近一条', () => {
    const recovered = evaluateDomainStatus(
      'cardiovascular',
      input({ readings: [reading('sbp', 185, 3), reading('sbp', 130, 1)] }),
    );
    // 不再是红；但 7 天平均 157.5 仍高于固定阈值，为黄
    expect(recovered.level).toBe('yellow');
    expect(recovered.basis[0]!.hits.map((h) => h.method)).toEqual(['threshold']);
    const now = evaluateDomainStatus(
      'cardiovascular',
      input({ readings: [reading('sbp', 130, 3), reading('sbp', 185, 1)] }),
    );
    expect(now.level).toBe('red');
    expect(now.basis[0]).toMatchObject({ latestValue: 185 });
  });

  it('报告和监测都有时分别判断，取更严重的', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({
        reportValues: [report('sbp', 150, '2026-08-01', { refHigh: 140, abnormal: 'high' })],
        readings: [reading('sbp', 185, 1)],
      }),
    );
    expect(s.level).toBe('red');
    expect(s.basis.map((b) => `${b.source}:${b.outcome}`)).toEqual([
      'report:yellow',
      'monitoring:red',
    ]);
  });

  it('睡眠没有默认阈值：有数据为绿，没数据为灰', () => {
    expect(
      evaluateDomainStatus('sleep', input({ readings: [reading('sleep_hours', 4.5, 1)] })).level,
    ).toBe('green');
    expect(evaluateDomainStatus('sleep', input({})).level).toBe('unknown');
  });

  it('单位和目录不一致的数值不参与（如 mg/dL 的血糖）', () => {
    const s = evaluateDomainStatus(
      'metabolic',
      input({ readings: [reading('fpg', 110, 1, 'mg/dL')] }),
    );
    expect(s.level).toBe('unknown');
    expect(s.skipped).toEqual([
      expect.objectContaining({ metric: 'fpg', source: 'monitoring', reason: 'unit_mismatch' }),
    ]);
  });

  it('超出合理范围的离群值（明显误填）不参与，不会把平均值拉高', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({
        readings: [reading('sbp', 1300, 1), reading('sbp', 128, 2), reading('sbp', 132, 3)],
      }),
    );
    expect(1300).toBeGreaterThan(THRESHOLD_BOUNDS.sbp.max);
    expect(s.level).toBe('green');
    expect(s.basis[0]).toMatchObject({ value: 130, count: 2 });
    expect(s.skipped.map((x) => x.reason)).toEqual(['out_of_bounds']);
  });

  it('停用的规则和停用的危急阈值不生效', () => {
    const rules = RULES.map((r) =>
      r.metric === 'fpg' && r.method === 'out_of_reference' ? { ...r, enabled: false } : r,
    );
    const s = evaluateDomainStatus(
      'metabolic',
      input({
        rules,
        reportValues: [report('fpg', 6.5, '2026-09-01', { abnormal: 'high' })],
      }),
    );
    expect(s.level).toBe('green');
    const noCritical = evaluateDomainStatus(
      'cardiovascular',
      input({
        criticalRules: DEFAULT_CRITICAL_RULES.map((c) => ({ ...c, enabled: false })),
        reportValues: [report('sbp', 185, '2026-09-01')],
      }),
    );
    expect(noCritical.level).toBe('green');
  });

  it('未来时间的读数不参与', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({ readings: [reading('sbp', 190, -1)] }),
    );
    expect(s.level).toBe('unknown');
  });

  it('不属于这个方面的指标不参与（血脂不让心血管变色）', () => {
    const s = evaluateDomainStatus(
      'cardiovascular',
      input({ reportValues: [report('tc', 7.5, '2026-09-01', { abnormal: 'high' })] }),
    );
    expect(s.level).toBe('unknown');
  });
});
