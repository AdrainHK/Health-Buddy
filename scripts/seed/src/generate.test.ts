import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITICAL_RULES,
  DEFAULT_TWIN_STATUS_RULES,
  REPORT_INDICATORS,
  abnormalFromColumns,
  evaluateTwinStatus,
  forecastMetric,
  indicatorUnit,
  type IndicatorCode,
} from '@health-buddy/shared';
import {
  DEMO_EMAIL_DOMAIN,
  TWIN_MONITORING_DAYS,
  TWIN_SCENARIOS,
  generateDemoData,
  SYNTHETIC_LABEL,
  type DemoClient,
  type TwinScenario,
} from './generate.js';

const today = new Date('2026-10-15T00:00:00Z');

describe('generateDemoData', () => {
  const data = generateDemoData({ today });
  const managers = data.flatMap((op) => op.org.managers);
  const clients = managers.flatMap((m) => m.clients);
  /** M0 的普通演示客户（不含 M4 的孪生演示客户） */
  const plain = clients.filter((c) => !c.twinScenario);

  it('matches the size in the M0 spec', () => {
    expect(data).toHaveLength(2);
    expect(managers).toHaveLength(6);
    expect(clients).toHaveLength(60);
    expect(plain).toHaveLength(50);
    for (const c of plain) {
      expect(c.reports.length).toBeGreaterThanOrEqual(2);
      expect(c.reports.length).toBeLessThanOrEqual(3);
    }
  });

  it('is reproducible for the same seed', () => {
    expect(generateDemoData({ today })).toEqual(data);
    expect(generateDemoData({ today, seed: 1 })).not.toEqual(data);
  });

  it('labels every person and report as test data', () => {
    for (const c of clients) {
      expect(c.displayName.endsWith(SYNTHETIC_LABEL)).toBe(true);
      for (const r of c.reports) expect(r.title).toContain(SYNTHETIC_LABEL);
    }
    for (const m of managers) expect(m.displayName.endsWith(SYNTHETIC_LABEL)).toBe(true);
  });

  it('uses reserved test email addresses only', () => {
    const emails = data.flatMap((op) => [
      op.admin.email,
      op.org.admin.email,
      ...op.org.managers.map((m) => m.email),
    ]);
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) expect(e.endsWith(`@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
  });

  it('only uses indicator codes from the shared catalog', () => {
    const known = new Set<string>(REPORT_INDICATORS.map((i) => i.code));
    for (const c of clients)
      for (const r of c.reports)
        for (const code of Object.keys(r.indicators)) expect(known.has(code)).toBe(true);
  });

  it('puts monitoring data in the 30 days before today', () => {
    const earliest = today.getTime() - 30 * 86_400_000;
    for (const c of plain) {
      expect(c.readings.length).toBeGreaterThan(0);
      for (const r of c.readings) {
        expect(r.measuredAt.getTime()).toBeGreaterThanOrEqual(earliest);
        expect(r.measuredAt.getTime()).toBeLessThan(today.getTime());
      }
    }
  });

  it('produces values in plausible ranges', () => {
    for (const c of clients) {
      const latest = c.reports.at(-1)?.indicators ?? {};
      expect(latest.fpg).toBeGreaterThan(3);
      expect(latest.fpg).toBeLessThan(9);
      expect(latest.sbp).toBeGreaterThan(90);
      expect(latest.sbp).toBeLessThan(180);
      expect(latest.bmi).toBeGreaterThan(16);
      expect(latest.bmi).toBeLessThan(36);
    }
  });

  it('mixes risk profiles so later milestones have something to work with', () => {
    expect(new Set(clients.map((c) => c.profile)).size).toBe(5);
  });
});

describe('孪生演示客户（M4 规格 6.2）', () => {
  const data = generateDemoData({ today });
  const now = today.toISOString();
  const rules = DEFAULT_TWIN_STATUS_RULES.map((r, i) => ({ ...r, id: `r${i}`, enabled: true }));

  const twins = data.flatMap((op) =>
    op.org.managers.flatMap((m, mi) =>
      m.clients.filter((c) => c.twinScenario).map((c) => ({ c, mi })),
    ),
  );

  /** 按后端的做法把演示客户的数据交给纯函数（报告参考范围按写库时的方式算高低标记） */
  function evaluate(c: DemoClient) {
    const reportValues = c.reports.flatMap((r, ri) =>
      Object.entries(r.indicators).map(([code, value]) => {
        const ref = r.references?.[code as never] as
          { low: number | null; high: number | null } | undefined;
        const text = ref
          ? ref.low !== null && ref.high !== null
            ? `${ref.low}-${ref.high}`
            : ref.high !== null
              ? `≤${ref.high}`
              : `≥${ref.low}`
          : null;
        return {
          indicatorId: `${ri}-${code}`,
          reportId: `${ri}`,
          metric: code,
          value,
          unit: indicatorUnit(code as IndicatorCode),
          reportDate: r.reportDate,
          refLow: ref?.low ?? null,
          refHigh: ref?.high ?? null,
          abnormal: abnormalFromColumns(value, ref?.low ?? null, ref?.high ?? null, text),
        };
      }),
    );
    const readings = c.readings.map((r, i) => ({
      id: String(i),
      metric: r.metric,
      value: r.value,
      unit: indicatorUnit(r.metric),
      measuredAt: r.measuredAt.toISOString(),
    }));
    const status = Object.fromEntries(
      evaluateTwinStatus({
        rules,
        rulesVersion: 1,
        criticalRules: DEFAULT_CRITICAL_RULES,
        reportValues,
        readings,
        now,
      }).map((s) => [s.domain, s.level]),
    );
    const forecast = (metric: IndicatorCode, source: 'report' | 'monitoring') =>
      forecastMetric({
        metric,
        source,
        now,
        observations:
          source === 'report'
            ? reportValues
                .filter((v) => v.metric === metric)
                .map((v) => ({ at: v.reportDate, value: v.value, unit: v.unit }))
            : readings
                .filter((r) => r.metric === metric)
                .map((r) => ({ at: r.measuredAt, value: r.value, unit: r.unit })),
      });
    return { status, forecast };
  }

  const byScenario = (s: TwinScenario) =>
    twins.filter(({ c }) => c.twinScenario === s).map(({ c }) => c);

  it('每个协会第一位健管师各有 5 位，覆盖五种类型', () => {
    expect(twins).toHaveLength(2 * TWIN_SCENARIOS.length);
    expect(new Set(twins.map(({ mi }) => mi))).toEqual(new Set([0]));
    for (const s of TWIN_SCENARIOS) expect(byScenario(s)).toHaveLength(2);
    for (const { c } of twins) expect(c.displayName.endsWith(SYNTHETIC_LABEL)).toBe(true);
  });

  it('有足够的历史数据：4 份带参考范围的报告和 26 周监测（数据不足类除外）', () => {
    for (const { c } of twins) {
      if (c.twinScenario === 'sparse') {
        expect(c.reports).toHaveLength(1);
        expect(c.readings).toHaveLength(0);
        continue;
      }
      expect(c.reports).toHaveLength(4);
      for (const r of c.reports) expect(r.references?.fpg).toEqual({ low: 3.9, high: 6.1 });
      const earliest = Math.min(...c.readings.map((r) => r.measuredAt.getTime()));
      expect((today.getTime() - earliest) / 86_400_000).toBeGreaterThan(TWIN_MONITORING_DAYS - 1);
      for (const r of c.readings) expect(r.measuredAt.getTime()).toBeLessThan(today.getTime());
    }
  });

  it('按默认规则算出红黄绿灰', () => {
    for (const c of byScenario('stable'))
      expect(evaluate(c).status).toEqual({
        metabolic: 'green',
        cardiovascular: 'green',
        sleep: 'green',
        weight: 'green',
      });
    for (const c of byScenario('worsening'))
      expect(evaluate(c).status).toMatchObject({ metabolic: 'yellow', cardiovascular: 'red' });
    for (const c of byScenario('improving'))
      expect(evaluate(c).status).toMatchObject({ weight: 'yellow', cardiovascular: 'green' });
    for (const c of byScenario('volatile'))
      expect(evaluate(c).status).toMatchObject({ cardiovascular: 'yellow' });
    for (const c of byScenario('sparse'))
      expect(evaluate(c).status).toEqual({
        metabolic: 'unknown',
        cardiovascular: 'unknown',
        sleep: 'unknown',
        weight: 'unknown',
      });
  });

  it('能做 3 个月和 6 个月的预测，走势和类型一致', () => {
    for (const c of byScenario('stable')) {
      const f = evaluate(c).forecast('sbp', 'monitoring');
      expect(f.points.map((p) => p.monthsAhead)).toEqual([3, 6]);
      expect(f.uncertainty).toBe('normal');
      expect(
        evaluate(c)
          .forecast('fpg', 'report')
          .points.map((p) => p.monthsAhead),
      ).toEqual([3, 6]);
    }
    for (const c of byScenario('worsening')) {
      const f = evaluate(c).forecast('fpg', 'report');
      expect(f.status).toBe('ok');
      expect(f.points[1]!.mid).toBeGreaterThan(6.6);
      expect(evaluate(c).forecast('sbp', 'monitoring').fit!.slopePerDay).toBeGreaterThan(0);
    }
    for (const c of byScenario('improving'))
      expect(evaluate(c).forecast('weight', 'monitoring').fit!.slopePerDay).toBeLessThan(0);
    for (const c of byScenario('volatile'))
      expect(evaluate(c).forecast('sbp', 'monitoring').uncertainty).toBe('high');
    for (const c of byScenario('sparse'))
      expect(evaluate(c).forecast('sbp', 'report')).toMatchObject({
        status: 'insufficient_data',
        pointsNeeded: 2,
      });
  });

  it('普通演示客户不受影响（同一种子生成的其余客户不变）', () => {
    const again = generateDemoData({ today });
    expect(again).toEqual(data);
    const other = data[0]!.org.managers[1]!.clients;
    expect(other.every((c) => !c.twinScenario)).toBe(true);
  });
});
