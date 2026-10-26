import { Logger, type INestApplication } from '@nestjs/common';
import { generateDemoData, writeDemoData } from '@health-buddy/seed';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/database.js';
import { computePendingTwins } from '../src/twin/compute-pending.js';
import { TwinComputeService } from '../src/twin/twin-compute.service.js';
import { TWIN_QUEUE, type InProcessTwinQueue } from '../src/twin/twin-queue.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

/**
 * 孪生计算队列（M4 规格 3.2）：任务只带客户 id，执行时从数据库重新找出健管师；
 * 构造出来的任务不能读写别人的数据；计算期间客户转出则丢弃结果；
 * 日志和任务参数里只有 id、颜色、类型、数量。
 */
describe('孪生计算队列', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let queue: InProcessTwinQueue;
  let service: TwinComputeService;

  const countRows = async (clientId: string) => {
    const n = async (table: 'twin_status_history' | 'twin_forecasts' | 'follow_up_items') =>
      (
        await owner
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('client_id', '=', clientId)
          .executeTakeFirstOrThrow()
      ).n;
    return {
      status: Number(await n('twin_status_history')),
      forecasts: Number(await n('twin_forecasts')),
      followUps: Number(await n('follow_up_items')),
    };
  };

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp();
    queue = app.get(TWIN_QUEUE);
    service = app.get(TwinComputeService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await queue.idle();
    await app.close();
    await owner.destroy();
  });

  it('构造的任务（多带租户字段、指定别的健管师）直接失败，不读任何数据、不写任何行', async () => {
    // 私有方法：读数据的入口
    const load = vi.spyOn(service.engine as unknown as { load: () => unknown }, 'load');
    const before = await countRows(f.clients.b1);
    for (const job of [
      {
        type: 'client',
        clientId: f.clients.b1,
        trigger: 'monitoring',
        managerId: f.users.managerA1.id,
      },
      {
        type: 'client',
        clientId: f.clients.b1,
        trigger: 'monitoring',
        operatorId: f.operatorA,
        orgId: f.orgA,
      },
      { type: 'client', clientId: f.clients.b1, trigger: 'not_a_trigger' },
      { type: 'client', clientId: 'not-a-uuid', trigger: 'monitoring' },
      { type: 'all', trigger: 'monitoring' },
      { type: 'client', clientId: '00000000-0000-4000-8000-000000000000', trigger: 'monitoring' },
    ]) {
      expect(await queue.run(job), JSON.stringify(Object.keys(job))).toBe('failed');
    }
    expect(load).not.toHaveBeenCalled();
    expect(await countRows(f.clients.b1)).toEqual(before);
  });

  it('客户的健管师已停用：任务被拒绝，不读数据', async () => {
    const load = vi.spyOn(service.engine as unknown as { load: () => unknown }, 'load');
    await owner
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('id', '=', f.users.managerA2.id)
      .execute();
    try {
      expect(
        await queue.run({ type: 'client', clientId: f.clients.a2, trigger: 'monitoring' }),
      ).toBe('failed');
      expect(load).not.toHaveBeenCalled();
      expect((await countRows(f.clients.a2)).status).toBe(0);
    } finally {
      await owner
        .updateTable('users')
        .set({ status: 'active' })
        .where('id', '=', f.users.managerA2.id)
        .execute();
    }
  });

  it('合规的任务在客户当前健管师的上下文里计算，写入的行带他的租户字段', async () => {
    expect(await queue.run({ type: 'client', clientId: f.clients.b1, trigger: 'monitoring' })).toBe(
      'completed',
    );
    const rows = await owner
      .selectFrom('twin_status_history')
      .select(['operator_id', 'org_id', 'manager_id', 'trigger'])
      .where('client_id', '=', f.clients.b1)
      .execute();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toEqual({
        operator_id: f.operatorB,
        org_id: f.orgB,
        manager_id: f.users.managerB1.id,
        trigger: 'monitoring',
      });
    }
  });

  it('计算期间客户被转给别的健管师：写库前重新确认归属，结果丢弃，不写任何行', async () => {
    const clientId = f.clients.a1[1];
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: clientId,
        metric: 'sbp',
        value: 186,
        unit: 'mmHg',
        measured_at: new Date(Date.now() - 3600_000),
        source: 'synthetic',
      })
      .execute();
    const before = await countRows(clientId);
    const engine = service.engine;
    const original = engine.plan.bind(engine);
    vi.spyOn(engine, 'plan').mockImplementation(async (input) => {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', clientId)
        .execute();
      return original(input);
    });
    try {
      const result = await engine.compute(clientId, 'monitoring');
      expect(result.outcome).toBe('discarded');
      expect(await countRows(clientId)).toEqual(before);
    } finally {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA1.id })
        .where('id', '=', clientId)
        .execute();
    }
  });

  it('日志和任务参数里不出现姓名、数值、理由、备注和依据文字', async () => {
    const logged: string[] = [];
    const capture =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push(
          `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
        );
      };
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(capture(level));
      vi.spyOn(Logger, level).mockImplementation(capture(level));
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(capture(`console.${level}`));
    }
    const jobsBefore = queue.jobs.length;
    const clientId = f.clients.a1[0];
    const a1 = await loginAs(app, f.users.managerA1.email);
    const REASON = '客户自述最近头晕需要关注';
    const NOTE = '已电话联系建议近期复测血压';
    await a1.get(`/api/clients/${clientId}/twin`).expect(200);
    await queue.idle();
    await a1
      .post(`/api/clients/${clientId}/monitoring-readings`)
      .send({ metric: 'sbp', value: 187.6, measuredAt: new Date().toISOString() })
      .expect(201);
    await queue.idle();
    await a1
      .post(`/api/clients/${clientId}/twin/status`)
      .send({ domain: 'weight', level: 'yellow', reason: REASON })
      .expect(200);
    const list = await a1.get(`/api/follow-ups?clientId=${clientId}`).expect(200);
    const item = (list.body.items as { id: string; kind: string }[]).find(
      (i) => i.kind === 'critical',
    )!;
    expect(item).toBeDefined();
    await a1
      .patch(`/api/follow-ups/${item.id}`)
      .send({ action: 'done', resolution: 'called', note: NOTE })
      .expect(200);
    // 构造的任务失败时也只记类型
    await queue.run({ type: 'client', clientId, trigger: 'monitoring', name: '测试客户 A1-1' });
    await queue.idle();

    expect(logged.some((l) => l.includes('twin compute'))).toBe(true);
    const client = await owner
      .selectFrom('clients')
      .select('display_name')
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    const jobs = JSON.stringify(queue.jobs.slice(jobsBefore).map((j) => j.data));
    for (const text of [...logged, jobs]) {
      for (const secret of [
        client.display_name,
        '187.6',
        REASON,
        NOTE,
        'mmHg',
        'observedOn',
        'basis',
      ]) {
        expect(text, text).not.toContain(secret);
      }
    }
    // 任务参数只有 type、clientId、trigger
    for (const j of queue.jobs.slice(jobsBefore)) {
      expect(Object.keys(j.data).sort()).toEqual(
        j.data.type === 'client' ? ['clientId', 'trigger', 'type'] : ['trigger', 'type'],
      );
    }
  });

  it('合成数据生成后全量计算：每位合成客户都有状态，触发原因为 seed；再运行一次不重复计算', async () => {
    await writeDemoData(owner, generateDemoData({ today: new Date() }), 'demo-password-for-tests');
    const appDb = createDb(TEST_APP_URL, 2);
    try {
      const first = await computePendingTwins(appDb, { syntheticOnly: true });
      expect(first.computed).toBeGreaterThanOrEqual(60);
      expect(first.skipped).toBe(0);
      const demo = await owner
        .selectFrom('clients')
        .innerJoin('operators', 'operators.id', 'clients.operator_id')
        .select('clients.id')
        .where('operators.slug', 'like', 'demo-%')
        .execute();
      expect(demo).toHaveLength(60);
      const seeded = await owner
        .selectFrom('twin_status_history')
        .select('client_id')
        .distinct()
        .where('trigger', '=', 'seed')
        .where(
          'client_id',
          'in',
          demo.map((d) => d.id),
        )
        .execute();
      expect(seeded).toHaveLength(60);
      // 合成数据里有超出范围的值，应该有跟进项和预测
      const followUps = await owner
        .selectFrom('follow_up_items')
        .select('id')
        .where(
          'client_id',
          'in',
          demo.map((d) => d.id),
        )
        .execute();
      expect(followUps.length).toBeGreaterThan(0);
      expect(await computePendingTwins(appDb, { syntheticOnly: true })).toEqual({
        computed: 0,
        skipped: 0,
      });
    } finally {
      await appDb.destroy();
    }
  }, 120_000);
});
