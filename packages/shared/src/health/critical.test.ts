import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITICAL_RULES,
  INDICATOR_CODES,
  THRESHOLD_BOUNDS,
  indicatorUnit,
  detectCriticalFlags,
  matchesRule,
} from './critical.js';

describe('critical thresholds', () => {
  it('has bounds for every indicator in the catalog', () => {
    for (const code of INDICATOR_CODES) expect(THRESHOLD_BOUNDS[code]).toBeDefined();
  });

  it('keeps every default inside its bounds', () => {
    for (const rule of DEFAULT_CRITICAL_RULES) {
      const { min, max } = THRESHOLD_BOUNDS[rule.metric];
      expect(rule.value).toBeGreaterThanOrEqual(min);
      expect(rule.value).toBeLessThanOrEqual(max);
    }
  });

  it('compares with the right operator at the boundary', () => {
    expect(matchesRule({ comparator: 'gte', value: 180 }, 180)).toBe(true);
    expect(matchesRule({ comparator: 'gt', value: 130 }, 130)).toBe(false);
    expect(matchesRule({ comparator: 'lt', value: 3 }, 3)).toBe(false);
    expect(matchesRule({ comparator: 'lte', value: 3 }, 3)).toBe(true);
  });

  it('flags the values named in the spec acceptance criteria', () => {
    const hits = (metric: string, v: number) =>
      DEFAULT_CRITICAL_RULES.filter((r) => r.metric === metric && matchesRule(r, v));
    expect(hits('sbp', 185)).toHaveLength(1);
    expect(hits('fpg', 2.8)).toHaveLength(1);
    expect(hits('sbp', 135)).toHaveLength(0);
  });

  it('reads units from the catalog', () => {
    expect(indicatorUnit('fpg')).toBe('mmol/L');
    expect(indicatorUnit('uric_acid')).toBe('umol/L');
  });
});

describe('detectCriticalFlags', () => {
  const obs = (
    metric: string,
    value: number,
    observedOn: string,
    source: 'monitoring' | 'report' = 'monitoring',
  ) => ({ metric, value, unit: indicatorUnit(metric as never), observedOn, source });

  it('uses only the latest value of each metric in each source', () => {
    const flags = detectCriticalFlags(DEFAULT_CRITICAL_RULES, [
      obs('sbp', 190, '2026-10-01'),
      obs('sbp', 150, '2026-10-05'),
      obs('fpg', 2.8, '2026-09-01', 'report'),
    ]);
    expect(flags).toEqual([
      {
        metric: 'fpg',
        value: 2.8,
        unit: 'mmol/L',
        observedOn: '2026-09-01',
        source: 'report',
        rule: { comparator: 'lt', value: 3, level: 'urgent' },
      },
    ]);
  });

  it('skips disabled rules and puts urgent flags first', () => {
    const rules = [
      ...DEFAULT_CRITICAL_RULES,
      {
        metric: 'sbp' as const,
        comparator: 'gte' as const,
        value: 160,
        level: 'attention' as const,
        enabled: false,
      },
    ];
    const flags = detectCriticalFlags(rules, [
      obs('uric_acid', 600, '2026-10-01'),
      obs('sbp', 185, '2026-10-02'),
    ]);
    expect(flags.map((f) => [f.metric, f.rule.level])).toEqual([
      ['sbp', 'urgent'],
      ['uric_acid', 'attention'],
    ]);
  });

  it('returns nothing for normal values', () => {
    expect(detectCriticalFlags(DEFAULT_CRITICAL_RULES, [obs('sbp', 120, '2026-10-01')])).toEqual(
      [],
    );
  });
});
