import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITICAL_RULES } from '../health/critical.js';
import { forecastMetric } from '../health/forecast.js';
import { DEFAULT_TWIN_STATUS_RULES, evaluateTwinStatus } from '../health/twin.js';
import {
  FOLLOW_UP_KIND_SEVERITIES,
  compareFollowUps,
  timeZoneSchema,
  updateFollowUpRequestSchema,
} from './follow-ups.js';
import { updateMeRequestSchema } from './auth.js';
import { createMonitoringReadingRequestSchema, monitoringReadingSchema } from './monitoring.js';
import { twinStatsQuerySchema, twinUsageStatsSchema } from './twin-stats.js';
import { createTwinStatusRuleRequestSchema } from './twin-rules.js';
import {
  TWIN_COMPUTE_TRIGGERS,
  isBatchTwinTrigger,
  forecastResultSchema,
  setTwinStatusRequestSchema,
  twinBasisItemSchema,
  twinRefSchema,
  twinTimelineEventSchema,
} from './twin.js';

describe('孪生契约', () => {
  it('手动调整必须写理由（不少于 5 个字），不能调成“数据不足”', () => {
    const ok = setTwinStatusRequestSchema.parse({
      domain: 'metabolic',
      level: 'green',
      reason: '客户已复查，结果正常',
    });
    expect(ok.expires).toBe('next_data');
    for (const bad of [
      { domain: 'metabolic', level: 'green' },
      { domain: 'metabolic', level: 'green', reason: '  正常  ' },
      { domain: 'metabolic', level: 'unknown', reason: '客户已复查，结果正常' },
      { domain: 'liver', level: 'green', reason: '客户已复查，结果正常' },
      { domain: 'metabolic', level: 'green', reason: '客户已复查，结果正常', expires: 'never' },
    ])
      expect(setTwinStatusRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('纯函数的输出符合依据和预测的 schema', () => {
    const now = '2026-10-18T08:00:00Z';
    const statuses = evaluateTwinStatus({
      rules: DEFAULT_TWIN_STATUS_RULES.map((r, i) => ({ ...r, id: `r${i}`, enabled: true })),
      rulesVersion: 1,
      criticalRules: DEFAULT_CRITICAL_RULES,
      reportValues: [
        {
          indicatorId: 'i1',
          reportId: 'p1',
          metric: 'fpg',
          value: 6.5,
          unit: 'mmol/L',
          reportDate: '2026-09-01',
          refLow: 3.9,
          refHigh: 6.1,
          abnormal: 'high',
        },
      ],
      readings: [
        { id: '1', metric: 'sbp', value: 185, unit: 'mmHg', measuredAt: '2026-10-17T07:00:00Z' },
      ],
      now,
    });
    for (const s of statuses) for (const b of s.basis) twinBasisItemSchema.parse(b);
    const f = forecastMetric({
      metric: 'sbp',
      source: 'report',
      observations: [
        { at: '2025-01-01', value: 130, unit: 'mmHg' },
        { at: '2025-08-01', value: 134, unit: 'mmHg' },
        { at: '2026-03-01', value: 133, unit: 'mmHg' },
        { at: '2026-09-01', value: 138, unit: 'mmHg' },
      ],
      now,
    });
    expect(forecastResultSchema.parse(f)).toEqual(f);
    const none = forecastMetric({ metric: 'sbp', source: 'report', observations: [], now });
    expect(forecastResultSchema.parse(none)).toEqual(none);
  });

  it('孪生项引用只能是方面或指标编码', () => {
    expect(twinRefSchema.safeParse({ kind: 'domain', code: 'metabolic' }).success).toBe(true);
    expect(twinRefSchema.safeParse({ kind: 'client', code: 'x' }).success).toBe(false);
    expect(twinRefSchema.safeParse({ kind: 'metric', code: 'DROP TABLE' }).success).toBe(false);
  });

  it('时间轴事件按类型区分，报告更正不带数值', () => {
    const e = twinTimelineEventSchema.parse({
      id: 'c1',
      at: '2026-10-18T08:00:00Z',
      type: 'correction',
      reportId: '6f1c2a5e-4f1b-4d3a-9b1e-2c3d4e5f6a7b',
      metric: 'fpg',
      actorName: null,
      value: 7.2,
    });
    expect(e).not.toHaveProperty('value');
  });
});

describe('跟进清单契约', () => {
  it('忽略必须选原因，暂缓只能选 1、3、7 天', () => {
    expect(updateFollowUpRequestSchema.safeParse({ action: 'dismiss' }).success).toBe(false);
    expect(
      updateFollowUpRequestSchema.safeParse({ action: 'dismiss', dismissReason: 'known' }).success,
    ).toBe(true);
    expect(updateFollowUpRequestSchema.safeParse({ action: 'snooze', snoozeDays: 2 }).success).toBe(
      false,
    );
    expect(
      updateFollowUpRequestSchema.safeParse({ action: 'done', note: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(updateFollowUpRequestSchema.safeParse({ action: 'reopen' }).success).toBe(true);
  });

  it('排序：严重程度 → 同级按最近触发时间从新到旧', () => {
    const items = [
      { id: 'a', severity: 3 as const, lastTriggeredAt: '2026-10-18T09:00:00Z' },
      { id: 'b', severity: 1 as const, lastTriggeredAt: '2026-10-10T09:00:00Z' },
      { id: 'c', severity: 3 as const, lastTriggeredAt: '2026-10-18T10:00:00Z' },
      { id: 'd', severity: 2 as const, lastTriggeredAt: '2026-10-01T09:00:00Z' },
    ];
    expect([...items].sort(compareFollowUps).map((i) => i.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('每种类型的严重程度和规格一致', () => {
    expect(FOLLOW_UP_KIND_SEVERITIES).toEqual({
      critical: [1, 2],
      status_red: [2],
      status_worsened: [3],
      forecast_deviation: [3, 4],
    });
  });
});

describe('规则和手动录入契约', () => {
  it('新增规则：形状不对时拒绝', () => {
    const base = {
      domain: 'cardiovascular',
      metric: 'sbp',
      source: 'monitoring',
      method: 'threshold',
      comparator: 'gt',
      value: 135,
      unit: 'mmHg',
      windowDays: 7,
      level: 'yellow',
    };
    expect(createTwinStatusRuleRequestSchema.parse(base).enabled).toBe(true);
    expect(createTwinStatusRuleRequestSchema.safeParse({ ...base, unit: 'kPa' }).success).toBe(
      false,
    );
    expect(createTwinStatusRuleRequestSchema.safeParse({ ...base, value: 900 }).success).toBe(
      false,
    );
    expect(
      createTwinStatusRuleRequestSchema.safeParse({ ...base, domain: 'metabolic' }).success,
    ).toBe(false);
  });

  it('手动录入：只能录目录里的监测指标，数值在合理范围内，时间不晚于现在', () => {
    const now = new Date().toISOString();
    expect(
      createMonitoringReadingRequestSchema.safeParse({ metric: 'sbp', value: 128, measuredAt: now })
        .success,
    ).toBe(true);
    for (const bad of [
      { metric: 'alt', value: 30, measuredAt: now },
      { metric: 'sbp', value: 1280, measuredAt: now },
      {
        metric: 'sbp',
        value: 128,
        measuredAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ])
      expect(createMonitoringReadingRequestSchema.safeParse(bad).success).toBe(false);
  });
});

describe('第 2 步新增契约', () => {
  it('批量触发（规则、阈值修改和补算）不生成跟进项', () => {
    expect(TWIN_COMPUTE_TRIGGERS.filter(isBatchTwinTrigger)).toEqual([
      'rules_changed',
      'thresholds_changed',
      'backfill',
    ]);
  });

  it('孪生统计：查询只接受日期和协会 id；行里没有健管师和客户 id', () => {
    expect(twinStatsQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-18' }).success).toBe(
      true,
    );
    expect(twinStatsQuerySchema.safeParse({ managerId: crypto.randomUUID() }).success).toBe(false);
    expect(Object.keys(twinUsageStatsSchema.shape)).not.toContain('managerId');
    expect(Object.keys(twinUsageStatsSchema.shape)).not.toContain('clientId');
  });

  it('时区：只接受 IANA 名称的形状', () => {
    for (const ok of ['Asia/Shanghai', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+8'])
      expect(timeZoneSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '../etc', 'Asia/Shang hai', "x';drop"])
      expect(timeZoneSchema.safeParse(bad).success, bad).toBe(false);
    expect(updateMeRequestSchema.safeParse({ timeZone: null }).success).toBe(true);
    expect(updateMeRequestSchema.safeParse({ timeZone: 'UTC', role: 'x' }).success).toBe(false);
  });

  it('监测读数：id 是数字字符串', () => {
    const base = {
      id: '42',
      clientId: crypto.randomUUID(),
      metric: 'sbp',
      value: 128,
      unit: 'mmHg',
      measuredAt: new Date().toISOString(),
      source: 'manual',
      deletable: true,
    };
    expect(monitoringReadingSchema.safeParse(base).success).toBe(true);
    expect(monitoringReadingSchema.safeParse({ ...base, id: 'abc' }).success).toBe(false);
  });
});
