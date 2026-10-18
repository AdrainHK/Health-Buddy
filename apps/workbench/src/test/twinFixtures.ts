import type {
  CriticalThreshold,
  FollowUpItem,
  FollowUpListResponse,
  TwinDomain,
  TwinDomainView,
  TwinForecast,
  TwinForecastDetailResponse,
  TwinLevel,
  TwinResponse,
  TwinStatusRecord,
  TwinTimelineResponse,
} from '@health-buddy/shared';
import { browserTimeZone } from '../api/twin';
import { CLIENTS, ids, NOW } from './mockApi';

/** 孪生测试用的合成数据。全部是虚构数据，不含真实客户信息。 */

export const twinIds = {
  record1: 'c0000000-0000-4000-8000-000000000001',
  record2: 'c0000000-0000-4000-8000-000000000002',
  forecast1: 'd0000000-0000-4000-8000-000000000001',
  forecast2: 'd0000000-0000-4000-8000-000000000002',
  follow1: 'e0000000-0000-4000-8000-000000000001',
  follow2: 'e0000000-0000-4000-8000-000000000002',
  follow3: 'e0000000-0000-4000-8000-000000000003',
  report: 'f0000000-0000-4000-8000-000000000001',
};

/** 带浏览器时区的查询串（跟进清单按健管师时区算“今日”） */
export function tzQuery(extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  const tz = browserTimeZone();
  if (tz) q.set('tz', tz);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function makeStatusRecord(overrides: Partial<TwinStatusRecord> = {}): TwinStatusRecord {
  return {
    id: twinIds.record1,
    domain: 'metabolic',
    level: 'yellow',
    origin: 'computed',
    basis: [
      {
        source: 'report',
        metric: 'fpg',
        value: 6.5,
        unit: 'mmol/L',
        observedOn: '2026-09-12',
        outcome: 'yellow',
        hits: [
          {
            ruleId: 'rule-1',
            method: 'out_of_reference',
            level: 'yellow',
            snapshot: { refLow: 3.9, refHigh: 6.1, abnormal: 'high' },
          },
        ],
        reportId: twinIds.report,
        indicatorId: 'i-1',
        refLow: 3.9,
        refHigh: 6.1,
        noReference: false,
      },
    ],
    rulesVersion: 3,
    reason: null,
    manualExpires: null,
    trigger: 'report_verified',
    setBy: null,
    setByName: null,
    createdAt: '2026-10-18T02:00:00.000Z',
    ...overrides,
  };
}

export function makeDomain(
  domain: TwinDomain,
  level: TwinLevel,
  overrides: Partial<TwinDomainView> = {},
): TwinDomainView {
  return {
    domain,
    level,
    computed:
      level === 'unknown'
        ? null
        : makeStatusRecord({
            domain,
            level,
            ...(domain === 'metabolic' ? {} : { basis: [] }),
          }),
    manual: null,
    manualExpiredByNewData: false,
    previousLevel: null,
    changedAt: null,
    ...overrides,
  };
}

export function makeForecast(overrides: Partial<TwinForecast> = {}): TwinForecast {
  return {
    id: twinIds.forecast1,
    metric: 'sbp',
    source: 'monitoring',
    methodVersion: 'ols-linear-v1',
    intervalLevel: 0.8,
    status: 'ok',
    insufficientReason: null,
    pointsNeeded: null,
    nPoints: 20,
    spanDays: 180,
    horizonMonths: 6,
    uncertainty: 'normal',
    basis: { kind: 'weekly_averages', from: '2026-04-20', to: '2026-10-12', anchor: '2026-10-15' },
    points: [
      { monthsAhead: 3, date: '2027-01-15', mid: 136, low: 128, high: 144, clipped: false },
      { monthsAhead: 6, date: '2027-04-15', mid: 142, low: 130, high: 154, clipped: false },
    ],
    computedAt: NOW,
    ...overrides,
  };
}

export function makeForecastDetail(
  overrides: Partial<TwinForecastDetailResponse> = {},
): TwinForecastDetailResponse {
  return {
    metric: 'sbp',
    unit: 'mmHg',
    actual: [
      { at: '2026-08-01T08:00:00.000Z', value: 126, source: 'monitoring', manual: false },
      { at: '2026-09-01T08:00:00.000Z', value: 129, source: 'monitoring', manual: false },
      { at: '2026-10-12T08:00:00.000Z', value: 132, source: 'monitoring', manual: true },
    ],
    forecasts: [makeForecast()],
    reference: { low: 90, high: 140 },
    ...overrides,
  };
}

export function makeTwin(overrides: Partial<TwinResponse> = {}): TwinResponse {
  return {
    client: CLIENTS[0]!,
    domains: [
      makeDomain('metabolic', 'yellow'),
      makeDomain('cardiovascular', 'green'),
      makeDomain('sleep', 'unknown'),
      makeDomain('weight', 'green'),
    ],
    riskTier: null,
    forecasts: [makeForecast()],
    openFollowUpCount: 0,
    hasOpenCritical: false,
    computing: false,
    hasData: true,
    ...overrides,
  };
}

export function makeFollowUp(overrides: Partial<FollowUpItem> = {}): FollowUpItem {
  return {
    id: twinIds.follow1,
    clientId: ids.clientA,
    clientName: CLIENTS[0]!.displayName,
    kind: 'status_worsened',
    severity: 3,
    domain: 'metabolic',
    metric: null,
    basis: {
      domain: 'metabolic',
      from: 'green',
      to: 'yellow',
      items: [
        {
          metric: 'fpg',
          source: 'report',
          value: 6.5,
          unit: 'mmol/L',
          observedOn: '2026-09-12',
          outcome: 'yellow',
        },
      ],
    },
    status: 'open',
    snoozeUntil: null,
    resolution: null,
    dismissReason: null,
    note: null,
    firstTriggeredAt: '2026-10-15T02:00:00.000Z',
    lastTriggeredAt: '2026-10-15T02:00:00.000Z',
    carriedDays: 3,
    consultedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

export const CRITICAL_FOLLOW_UP: FollowUpItem = makeFollowUp({
  id: twinIds.follow2,
  clientId: ids.clientB,
  clientName: CLIENTS[1]!.displayName,
  kind: 'critical',
  severity: 1,
  domain: 'cardiovascular',
  metric: 'sbp',
  basis: {
    source: 'monitoring',
    metric: 'sbp',
    value: 182,
    unit: 'mmHg',
    observedOn: '2026-10-17',
    rule: { comparator: 'gte', value: 180, level: 'urgent' },
  },
  lastTriggeredAt: '2026-10-17T02:00:00.000Z',
  carriedDays: 0,
});

export function followUpList(items: FollowUpItem[]): FollowUpListResponse {
  return {
    items,
    openCount: items.length,
    date: '2026-10-18',
    timeZone: browserTimeZone() ?? 'UTC',
  };
}

/** 危急阈值（合成）：默认的收缩压 ≥ 180，预测中间值最高 142，不会触发 */
export function makeThreshold(overrides: Partial<CriticalThreshold> = {}): CriticalThreshold {
  return {
    id: 'b0000000-0000-4000-8000-000000000001',
    metric: 'sbp',
    comparator: 'gte',
    value: 180,
    level: 'urgent',
    enabled: true,
    updatedBy: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export const EMPTY_TIMELINE: TwinTimelineResponse = { events: [], nextBefore: null };
