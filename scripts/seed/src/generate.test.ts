import { describe, expect, it } from 'vitest';
import { REPORT_INDICATORS } from '@health-buddy/shared';
import { DEMO_EMAIL_DOMAIN, generateDemoData, SYNTHETIC_LABEL } from './generate.js';

const today = new Date('2026-10-15T00:00:00Z');

describe('generateDemoData', () => {
  const data = generateDemoData({ today });
  const managers = data.flatMap((op) => op.org.managers);
  const clients = managers.flatMap((m) => m.clients);

  it('matches the size in the M0 spec', () => {
    expect(data).toHaveLength(2);
    expect(managers).toHaveLength(6);
    expect(clients).toHaveLength(60);
    for (const c of clients) {
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
    for (const c of clients) {
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
