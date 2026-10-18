import { describe, expect, it } from 'vitest';
import {
  adminExpertSchema,
  expertAvailabilityEventSchema,
  expertStatsQuerySchema,
  expertUsageStatsSchema,
} from './experts.js';

const counts = {
  calls: 4,
  succeeded: 3,
  timedOut: 1,
  successRate: 0.75,
  timeoutRate: 0.25,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.0012,
  useful: 2,
  notUseful: 1,
};

/** 专家后台统计和平台专家管理的契约（M3 规格 6.2、6.4，全部是合成数据） */
describe('专家统计和平台专家管理契约', () => {
  it('统计查询只接受日期和协会筛选，日期必须是 YYYY-MM-DD', () => {
    expect(expertStatsQuerySchema.safeParse({}).success).toBe(true);
    expect(
      expertStatsQuerySchema.safeParse({
        from: '2026-10-01',
        to: '2026-10-18',
        operatorId: '22222222-2222-4222-8222-222222222222',
      }).success,
    ).toBe(true);
    expect(expertStatsQuerySchema.safeParse({ from: '2026/10/01' }).success).toBe(false);
    expect(expertStatsQuerySchema.safeParse({ managerId: 'x' }).success).toBe(false);
  });

  it('统计行只有协会、专家、日期和汇总数字，解析时丢掉健管师、客户、任务 id', () => {
    const row = expertUsageStatsSchema.parse({
      operatorId: null,
      operatorName: null,
      expertId: 'nutrition',
      expertName: '营养专家',
      date: '2026-10-18',
      ...counts,
      managerId: '30000000-0000-4000-8000-000000000005',
      clientId: '30000000-0000-4000-8000-000000000006',
      taskId: '30000000-0000-4000-8000-000000000007',
    });
    for (const key of ['managerId', 'clientId', 'taskId']) expect(row).not.toHaveProperty(key);
    expect(expertUsageStatsSchema.safeParse({ ...row, successRate: 1.5 }).success).toBe(false);
  });

  it('专家列表项和暂停记录', () => {
    expect(
      adminExpertSchema.safeParse({
        id: 'nutrition',
        name: '营养专家',
        version: '0.1.0',
        sourcesVersion: '0123456789ab',
        status: 'review',
        sourcesPending: true,
        statusAllowed: false,
        enabled: true,
        updatedAt: null,
        evalCases: 7,
        evalTarget: 15,
        calls: 0,
        useful: 0,
        notUseful: 0,
      }).success,
    ).toBe(true);
    expect(
      expertAvailabilityEventSchema.safeParse({
        id: '80000000-0000-4000-8000-000000000001',
        expertId: 'nutrition',
        action: 'deleted',
        actorId: null,
        createdAt: '2026-10-18T08:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
