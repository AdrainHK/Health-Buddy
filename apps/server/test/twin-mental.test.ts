import type { INestApplication } from '@nestjs/common';
import { twinResponseSchema, type TwinDomainView } from '@health-buddy/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TwinComputeService } from '../src/twin/twin-compute.service.js';
import { TWIN_QUEUE, type InProcessTwinQueue } from '../src/twin/twin-queue.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M6 第 6c 步：孪生“心理”方面和收集信息条数规则（规格 Q20、N16，验收 11）。
 * 条数规则只有平台能改，默认停用；启用后情绪消极条数达到就变黄，依据只有条数、不写原话；
 * 只数服务这位客户的健管师本人的收集信息，客户撤回同意后不数。全部是合成数据。
 */
describe('孪生心理方面和条数规则', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let queue: InProcessTwinQueue;
  let service: TwinComputeService;

  const as = (email: string) => loginAs(app, email);
  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  const tenantOf = (clientId: string) =>
    owner
      .selectFrom('clients')
      .select(['operator_id', 'org_id', 'manager_id'])
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
  /** 用所有者身份写福宝整理的收集信息（相当于会话结束后的整理） */
  const seedMoods = async (clientId: string, polarities: (string | null)[], ago = 0) => {
    const t = await tenantOf(clientId);
    await owner
      .insertInto('companion_observations')
      .values(
        polarities.map((polarity, i) => ({
          ...t,
          client_id: clientId,
          category: 'mood',
          polarity,
          text: `合成：客户说这几天心里有点闷（第 ${i + 1} 条），电话 13812345678`,
          observed_on: ago ? daysAgo(ago) : today(),
        })),
      )
      .execute();
  };

  const moodRule = () =>
    owner
      .selectFrom('twin_status_rules')
      .selectAll()
      .where('method', '=', 'observation_count')
      .where('domain', '=', 'mental')
      .executeTakeFirstOrThrow();

  const enableMoodRule = async (platform: Agent) => {
    const rule = await moodRule();
    await platform
      .patch(`/api/admin/twin-status-rules/${rule.id}`)
      .send({ enabled: true })
      .expect(200);
    await queue.idle();
  };

  const mental = async (agent: Agent, clientId: string): Promise<TwinDomainView> => {
    await service.engine.compute(clientId, 'companion');
    const body = twinResponseSchema.parse(
      (await agent.get(`/api/clients/${clientId}/twin`).expect(200)).body,
    );
    return body.domains.find((d) => d.domain === 'mental')!;
  };

  beforeAll(async () => {
    app = await createTestApp();
    queue = app.get(TWIN_QUEUE);
    service = app.get(TwinComputeService);
  });

  beforeEach(async () => {
    await queue.idle();
    f = await seedFixtures(owner);
  });

  afterAll(async () => {
    await queue.idle();
    await app.close();
    await owner.destroy();
  });

  it('默认两条条数规则停用：情绪消极再多，心理方面也是灰（数据不足）', async () => {
    const rules = await owner
      .selectFrom('twin_status_rules')
      .select(['domain', 'category', 'polarity', 'window_days', 'min_count', 'enabled', 'metric'])
      .where('method', '=', 'observation_count')
      .orderBy('domain')
      .execute();
    expect(rules).toEqual([
      {
        domain: 'mental',
        category: 'mood',
        polarity: 'negative',
        window_days: 14,
        min_count: 3,
        enabled: false,
        metric: null,
      },
      {
        domain: 'sleep',
        category: 'sleep',
        polarity: 'negative',
        window_days: 14,
        min_count: 3,
        enabled: false,
        metric: null,
      },
    ]);
    await seedMoods(f.clients.a1[0], ['negative', 'negative', 'negative', 'negative']);
    const a1 = await as(f.users.managerA1.email);
    const view = await mental(a1, f.clients.a1[0]);
    expect(view.level).toBe('unknown');
    expect(view.computed?.basis).toEqual([]);
  });

  it('启用后：消极 3 条变黄，依据只有条数和日期、没有原话；状态历史的触发原因是 companion', async () => {
    const platform = await as(f.users.platform.email);
    await enableMoodRule(platform);
    await seedMoods(f.clients.a1[0], ['negative', 'negative', 'negative', 'positive']);
    const a1 = await as(f.users.managerA1.email);
    const view = await mental(a1, f.clients.a1[0]);
    expect(view.level).toBe('yellow');
    const basis = view.computed!.basis;
    expect(basis).toHaveLength(1);
    expect(basis[0]).toMatchObject({
      source: 'companion',
      metric: 'mood',
      polarity: 'negative',
      value: 3,
      unit: '条',
      count: 4,
      windowDays: 14,
      outcome: 'yellow',
    });
    const stored = JSON.stringify(
      await owner
        .selectFrom('twin_status_history')
        .select(['basis', 'trigger'])
        .where('client_id', '=', f.clients.a1[0])
        .where('domain', '=', 'mental')
        .execute(),
    );
    expect(stored).toContain('"trigger":"companion"');
    expect(stored).not.toContain('心里有点闷');
    expect(stored).not.toContain('13812345678');
  });

  it('差一条为绿；窗口（14 天）以外的不算', async () => {
    const platform = await as(f.users.platform.email);
    await enableMoodRule(platform);
    await seedMoods(f.clients.a1[0], ['negative', 'negative']);
    await seedMoods(f.clients.a1[0], ['negative', 'negative'], 20);
    const a1 = await as(f.users.managerA1.email);
    const view = await mental(a1, f.clients.a1[0]);
    expect(view.level).toBe('green');
    expect(view.computed!.basis[0]).toMatchObject({ value: 2, count: 2 });
  });

  it('客户撤回同意后不再数福宝的收集信息：心理回到灰', async () => {
    const platform = await as(f.users.platform.email);
    await enableMoodRule(platform);
    await seedMoods(f.clients.a1[0], ['negative', 'negative', 'negative']);
    const a1 = await as(f.users.managerA1.email);
    expect((await mental(a1, f.clients.a1[0])).level).toBe('yellow');
    // 平台先发布告知书模板，健管师记录同意，再记录撤回
    await platform
      .put('/api/admin/companion/scripts/notice')
      .send({ text: '测试用告知书：福宝不是医生，可以随时撤回同意。' })
      .expect(200);
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const base = `/api/clients/${f.clients.a1[0]}/companion`;
    const recorded = await a1
      .post(`${base}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: day, confirmed: true, chatDataConfirmed: true });
    expect(recorded.status, recorded.text).toBeLessThan(300);
    expect((await mental(a1, f.clients.a1[0])).level).toBe('yellow');
    const revoked = await a1
      .post(`${base}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: day });
    expect(revoked.status, revoked.text).toBeLessThan(300);
    expect((await mental(a1, f.clients.a1[0])).level).toBe('unknown');
  });

  it('只数服务这位客户的健管师本人的行：客户转出后新健管师接着数，原健管师看孪生 404', async () => {
    const platform = await as(f.users.platform.email);
    await enableMoodRule(platform);
    await seedMoods(f.clients.a1[0], ['negative', 'negative', 'negative']);
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
    ]) {
      const other = await as(email);
      await other.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(404);
    }
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const a1 = await as(f.users.managerA1.email);
    await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(404);
    const a2 = await as(f.users.managerA2.email);
    expect((await mental(a2, f.clients.a1[0])).level).toBe('yellow');
  });

  it('条数规则只有平台能改；形状不对 400（类别和方面不配、条数越界、带了指标）', async () => {
    const rule = await moodRule();
    for (const email of [f.users.managerA1.email, f.users.operatorAdminA.email]) {
      const agent = await as(email);
      await agent
        .patch(`/api/admin/twin-status-rules/${rule.id}`)
        .send({ enabled: true })
        .expect(403);
    }
    const platform = await as(f.users.platform.email);
    await platform
      .patch(`/api/admin/twin-status-rules/${rule.id}`)
      .send({ minCount: 0 })
      .expect(400);
    await platform
      .patch(`/api/admin/twin-status-rules/${rule.id}`)
      .send({ minCount: 101 })
      .expect(400);
    const updated = await platform
      .patch(`/api/admin/twin-status-rules/${rule.id}`)
      .send({ minCount: 5, windowDays: 30, level: 'red' })
      .expect(200);
    expect(updated.body.rule).toMatchObject({
      domain: 'mental',
      category: 'mood',
      polarity: 'negative',
      minCount: 5,
      windowDays: 30,
      level: 'red',
    });
    const base = {
      source: 'companion',
      method: 'observation_count',
      metric: null,
      comparator: null,
      value: null,
      unit: null,
      windowDays: 7,
      level: 'yellow',
      polarity: 'negative',
      minCount: 2,
    };
    await platform
      .post('/api/admin/twin-status-rules')
      .send({ ...base, domain: 'mental', category: 'sleep' })
      .expect(400);
    await platform
      .post('/api/admin/twin-status-rules')
      .send({ ...base, domain: 'mental', category: 'mood', metric: 'fpg' })
      .expect(400);
    await platform
      .post('/api/admin/twin-status-rules')
      .send({ ...base, domain: 'mental', category: 'mood', windowDays: null })
      .expect(400);
    // 合法的新规则（原规则已改成红，再加一条黄的）可以加；修改记录写下了新列
    await platform
      .post('/api/admin/twin-status-rules')
      .send({ ...base, domain: 'mental', category: 'mood', level: 'yellow', minCount: 8 })
      .expect(201);
    const event = await owner
      .selectFrom('twin_status_rule_events')
      .select('after')
      .where('action', '=', 'created')
      .executeTakeFirstOrThrow();
    expect(event.after).toMatchObject({ category: 'mood', polarity: 'negative', min_count: 8 });
  });

  it('数据库兜底：直接写不合法的条数规则被拒绝', async () => {
    await expect(
      owner
        .insertInto('twin_status_rules')
        .values({
          domain: 'sleep',
          metric: null,
          source: 'companion',
          method: 'observation_count',
          window_days: 14,
          level: 'yellow',
          category: 'mood',
          polarity: 'negative',
          min_count: 3,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner
        .insertInto('twin_status_rules')
        .values({
          domain: 'mental',
          metric: 'fpg',
          source: 'report',
          method: 'critical',
          level: 'red',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
