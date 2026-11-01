import { describe, expect, it } from 'vitest';
import { emptyMetrics, protectSmallGroups, type OpsMetrics } from './ops-dashboard.js';

const m = (managers: number, clients: number, llm = 1): OpsMetrics => ({
  ...emptyMetrics(),
  managers_opened: managers + 2,
  managers_active: managers,
  clients_total: clients,
  llm_calls: llm,
});
const org = (id: string, metrics: OpsMetrics, costUsd: number | null = null) => ({
  kind: 'org' as const,
  orgId: id,
  name: id,
  metrics,
  costUsd,
});

describe('小样本保护（M7 Q15）', () => {
  it('健管师或客户少于 5 的机构合并为“其他”；合并了两个以上、都够 5 时显示', () => {
    const out = protectSmallGroups([
      org('a', m(6, 30, 10), 1),
      org('b', m(3, 20, 2), 0.5),
      org('c', m(4, 2, 3), 0.5),
    ]);
    expect(out.map((g) => [g.kind, g.orgId, g.hidden])).toEqual([
      ['org', 'a', false],
      ['other', null, false],
    ]);
    expect(out[1]!.metrics).toMatchObject({ managers_active: 7, clients_total: 22, llm_calls: 5 });
    expect(out[1]!.costUsd).toBe(1);
  });

  it('“其他”只合并了一个机构时不显示（合规审查 B1），并二次隐藏最小的可见组', () => {
    const out = protectSmallGroups([
      org('big', m(20, 100)),
      org('mid', m(6, 10)),
      org('one', m(6, 2)),
    ]);
    expect(out.map((g) => [g.kind, g.orgId, g.hidden])).toEqual([
      ['org', 'big', false],
      ['org', 'mid', true],
      ['other', null, true],
    ]);
    expect(out[1]!.metrics).toEqual(emptyMetrics());
  });

  it('合并后健管师或客户仍少于 5 时不显示；客户不够也算（合规审查 B1）', () => {
    expect(protectSmallGroups([org('x', m(3, 2)), org('y', m(3, 1))]).at(-1)).toMatchObject({
      kind: 'other',
      hidden: true,
    });
    expect(protectSmallGroups([org('x', m(2, 9))])).toEqual([
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

describe('门槛按已激活的健管师算（租户审查 S1）', () => {
  it('待激活的邀请撑不过门槛', () => {
    const out = protectSmallGroups([
      org('big', m(20, 100)),
      org('padded', {
        ...emptyMetrics(),
        managers_opened: 9,
        managers_active: 1,
        clients_total: 9,
      }),
      org('mid', m(6, 10)),
    ]);
    expect(out.find((g) => g.orgId === 'padded')).toBeUndefined();
    expect(out.at(-1)).toMatchObject({ kind: 'other', hidden: true });
  });
});
