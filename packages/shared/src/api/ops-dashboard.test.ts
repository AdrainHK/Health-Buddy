import { describe, expect, it } from 'vitest';
import { emptyMetrics, protectSmallGroups, type OpsMetrics } from './ops-dashboard.js';

const m = (managers: number, clients: number, llm = 1): OpsMetrics => ({
  ...emptyMetrics(),
  managers_opened: managers,
  clients_total: clients,
  llm_calls: llm,
});

describe('小样本保护（M7 Q15）', () => {
  it('健管师或客户少于 5 的机构合并为“其他”', () => {
    const out = protectSmallGroups([
      { kind: 'org', orgId: 'a', name: '大机构', metrics: m(6, 30, 10), costUsd: 1 },
      { kind: 'org', orgId: 'b', name: '小机构一', metrics: m(3, 20, 2), costUsd: 0.5 },
      { kind: 'org', orgId: 'c', name: '小机构二', metrics: m(4, 2, 3), costUsd: 0.5 },
    ]);
    expect(out.map((g) => [g.kind, g.name, g.hidden])).toEqual([
      ['org', '大机构', false],
      ['other', null, false],
    ]);
    expect(out[1]!.metrics).toMatchObject({ managers_opened: 7, clients_total: 22, llm_calls: 5 });
    expect(out[1]!.costUsd).toBe(1);
  });

  it('合并后仍不足 5 人时不显示数字', () => {
    const out = protectSmallGroups([
      { kind: 'org', orgId: 'b', name: '小机构', metrics: m(2, 9), costUsd: null },
    ]);
    expect(out).toEqual([
      {
        kind: 'other',
        orgId: null,
        name: null,
        hidden: true,
        metrics: emptyMetrics(),
        costUsd: null,
      },
    ]);
  });
});
