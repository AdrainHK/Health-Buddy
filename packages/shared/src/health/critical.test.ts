import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITICAL_RULES,
  INDICATOR_CODES,
  THRESHOLD_BOUNDS,
  indicatorUnit,
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
