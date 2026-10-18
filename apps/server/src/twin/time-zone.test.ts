import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isValidTimeZone, localDate, zonedDayStart } from './time-zone.js';

describe('按健管师时区算“今日”（Q13）', () => {
  it('同一个时刻在不同时区是不同的日期', () => {
    const t = Date.parse('2026-10-18T20:30:00Z');
    expect(localDate(t, 'UTC')).toBe('2026-10-18');
    expect(localDate(t, 'Asia/Shanghai')).toBe('2026-10-19');
    expect(localDate(t, 'America/Los_Angeles')).toBe('2026-10-18');
  });

  it('某一天的 0 点换算成 UTC，夏令时切换当天也对', () => {
    expect(zonedDayStart('2026-10-19', 'Asia/Shanghai').toISOString()).toBe(
      '2026-10-18T16:00:00.000Z',
    );
    expect(zonedDayStart('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(zonedDayStart('2026-12-01', 'America/New_York').toISOString()).toBe(
      '2026-12-01T05:00:00.000Z',
    );
    // 2026-03-08 美东切换夏令时（凌晨 2 点），当天 0 点仍是 -05:00
    expect(zonedDayStart('2026-03-08', 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(zonedDayStart('2026-03-09', 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('日期加减和间隔', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-15', '2026-10-18')).toBe(3);
  });

  it('不认识的时区名', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
