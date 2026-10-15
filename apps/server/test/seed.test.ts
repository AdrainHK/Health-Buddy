import type { INestApplication } from '@nestjs/common';
import { generateDemoData, writeDemoData } from '@health-buddy/seed';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import request from 'supertest';

const SEED_PASSWORD = 'demo-password-for-tests';

describe('合成数据生成器', () => {
  const owner = ownerDb();
  let f: Fixtures;
  let app: INestApplication;
  const data = generateDemoData({ today: new Date('2026-10-15T00:00:00Z') });

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  const count = async (table: string) =>
    (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(owner))
      .rows[0]?.n;

  it('写入规格要求的规模，重复运行结果不变，也不影响其他数据', async () => {
    const before = { clients: await count('clients'), users: await count('users') };
    const first = await writeDemoData(owner, data, SEED_PASSWORD);
    expect(first).toMatchObject({ operators: 2, managers: 6, clients: 60 });
    expect(first.readings).toBeGreaterThan(60 * 20);

    const second = await writeDemoData(owner, data, SEED_PASSWORD);
    expect(second).toEqual(first);
    expect(await count('clients')).toBe(before.clients! + 60);
    expect(await count('users')).toBe(before.users! + 2 * (2 + 3));
    expect(await count('report_indicators')).toBe(first.indicators + 2);

    // 原有的测试数据原样保留
    const kept = await owner
      .selectFrom('clients')
      .select('id')
      .where('id', '=', f.clients.b1)
      .execute();
    expect(kept).toHaveLength(1);
  });

  it('全部客户都标记为合成数据', async () => {
    const real = await owner
      .selectFrom('clients')
      .innerJoin('operators', 'operators.id', 'clients.operator_id')
      .select('clients.id')
      .where('operators.slug', 'like', 'demo-%')
      .where('clients.is_synthetic', '=', false)
      .execute();
    expect(real).toHaveLength(0);
  });

  it('演示协会里出现非合成客户时中止，不删除任何数据', async () => {
    await writeDemoData(owner, data, SEED_PASSWORD);
    const demoClient = await owner
      .selectFrom('clients')
      .innerJoin('operators', 'operators.id', 'clients.operator_id')
      .select('clients.id')
      .where('operators.slug', '=', 'demo-assoc-a')
      .executeTakeFirstOrThrow();
    await owner
      .updateTable('clients')
      .set({ is_synthetic: false })
      .where('id', '=', demoClient.id)
      .execute();
    const before = await count('clients');
    try {
      await expect(writeDemoData(owner, data, SEED_PASSWORD)).rejects.toThrow(/已中止/);
      expect(await count('clients')).toBe(before);
    } finally {
      await owner
        .updateTable('clients')
        .set({ is_synthetic: true })
        .where('id', '=', demoClient.id)
        .execute();
    }
  });

  it('演示健管师可以登录，只看到自己的 10 位客户', async () => {
    const managerA1 = data[0]!.org.managers[0]!;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ email: managerA1.email, password: SEED_PASSWORD })
      .expect(200);
    const res = await agent.get('/api/clients').expect(200);
    expect(res.body.clients).toHaveLength(10);
    const names = (res.body.clients as { displayName: string }[]).map((c) => c.displayName).sort();
    expect(names).toEqual(managerA1.clients.map((c) => c.displayName).sort());
  });
});
