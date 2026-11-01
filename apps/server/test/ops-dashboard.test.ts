import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

/**
 * M7 第 5 步：运营看板（规格 2.6，验收 11、12、13、14，Q14、Q15）。只有汇总数字；
 * 少于 5 人的机构合并为“其他”；成本只给平台；协会、机构范围由数据库函数按会话决定。合成数据。
 */
describe('运营看板', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;

  const as = (email: string) => loginAs(app, email);
  const board = async (email: string, query = '') =>
    (await (await as(email)).get(`/api/admin/ops-dashboard${query}`).expect(200)).body;
  /** 给协会 A 的机构 A 补合成的健管师和客户，让它超过小样本门槛 */
  const growOrgA = async (managers: number, clients: number) => {
    const ids: string[] = [];
    for (let i = 0; i < managers; i++) {
      const row = await owner
        .insertInto('users')
        .values({
          email: `ops-m${i}@test.example`,
          password_hash: 'synthetic',
          display_name: `合成健管师${i}`,
          role: 'manager',
          operator_id: f.operatorA,
          org_id: f.orgA,
          status: 'active',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.push((row as { id: string }).id);
    }
    for (let i = 0; i < clients; i++) {
      await owner
        .insertInto('clients')
        .values({
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
          display_name: `合成客户${i}`,
          is_synthetic: true,
        } as never)
        .execute();
    }
    return ids;
  };
  const usage = (userId: string, operatorId: string, cost: number) =>
    owner
      .insertInto('llm_usage')
      .values({
        user_id: userId,
        operator_id: operatorId,
        route: 'chat',
        provider: 'openai',
        model: 'synthetic-model',
        input_tokens: 10,
        output_tokens: 10,
        cost_usd: cost,
        duration_ms: 5,
        outcome: 'complete',
      } as never)
      .execute();

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    await owner
      .updateTable('operators')
      .set({ seat_limit: 20 } as never)
      .where('id', '=', f.operatorA)
      .execute();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('验收 11、Q15：本协会合计和合成数据一致；少于 5 人的机构合并为“其他”，合并后仍不足 5 人时不显示', async () => {
    await usage(f.users.managerA1.id, f.operatorA, 0.5);
    await usage(f.users.managerA1.id, f.operatorA, 0.25);
    await usage(f.users.managerB1.id, f.operatorB, 9);
    const small = await board(f.users.operatorAdminA.email, '?days=30');
    expect(small.totals.metrics).toMatchObject({
      managers_opened: 3,
      managers_active: 3,
      managers_engaged: 1,
      clients_total: 4,
      llm_calls: 2,
    });
    expect(small.totals.costUsd).toBeNull();
    expect(small.seats).toEqual({ used: 3, limit: 20 });
    expect(small.groups).toEqual([
      expect.objectContaining({ kind: 'other', hidden: true, name: null }),
    ]);

    // 机构 A 补到 5 位健管师、6 位客户：单独显示；机构 A2 只有 1 人，合并为“其他”且不显示
    await growOrgA(3, 3);
    const grown = await board(f.users.operatorAdminA.email);
    const orgA = grown.groups.find((g: { orgId: string | null }) => g.orgId === f.orgA);
    expect(orgA).toMatchObject({ kind: 'org', name: '测试机构A', hidden: false });
    expect(orgA.metrics).toMatchObject({ managers_opened: 5, clients_total: 6, llm_calls: 2 });
    expect(grown.groups.find((g: { kind: string }) => g.kind === 'other')).toMatchObject({
      hidden: true,
    });
  });

  it('验收 12：响应里没有客户 id、姓名、健管师的账号信息和任何文字', async () => {
    await growOrgA(3, 3);
    await usage(f.users.managerA1.id, f.operatorA, 0.5);
    for (const email of [
      f.users.operatorAdminA.email,
      f.users.platform.email,
      f.users.orgAdminA.email,
    ]) {
      const text = JSON.stringify(await board(email));
      for (const leak of [
        ...f.clients.a1,
        f.clients.a2,
        f.clients.a3,
        f.clients.b1,
        f.users.managerA1.id,
        f.users.managerA1.email,
        '测试客户',
        '合成客户',
        '合成健管师',
      ]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it('验收 13、14、Q14：协会只看本协会（传别的协会无效）；机构管理员只看本机构；健管师 403；成本只给平台', async () => {
    await usage(f.users.managerA1.id, f.operatorA, 0.5);
    await usage(f.users.managerB1.id, f.operatorB, 9);
    const own = await board(f.users.operatorAdminA.email);
    const spoof = await board(f.users.operatorAdminA.email, `?operatorId=${f.operatorB}`);
    expect(spoof.totals).toEqual(own.totals);
    expect(spoof.operators).toBeNull();

    const orgAdmin = await board(f.users.orgAdminA2.email);
    expect(orgAdmin.totals.metrics).toMatchObject({
      managers_opened: 1,
      clients_total: 1,
      llm_calls: 0,
    });
    expect(orgAdmin.twinOpens).toBeNull();
    expect(orgAdmin.seats).toBeNull();

    const m = await as(f.users.managerA1.email);
    await m.get('/api/admin/ops-dashboard').expect(403);
    await (
      await as(f.users.operatorAdminA.email)
    )
      .get('/api/admin/ops-dashboard?days=15')
      .expect(400);

    const platform = await board(f.users.platform.email);
    expect(platform.totals.costUsd).toBeCloseTo(9.5);
    const rows = platform.operators as {
      operatorId: string;
      costUsd: number;
      metrics: { llm_calls: number };
    }[];
    expect(rows.find((r) => r.operatorId === f.operatorA)).toMatchObject({
      costUsd: 0.5,
      metrics: { llm_calls: 1 },
    });
    expect(rows.find((r) => r.operatorId === f.operatorB)).toMatchObject({ costUsd: 9 });
    const filtered = await board(f.users.platform.email, `?operatorId=${f.operatorB}`);
    expect(filtered.totals).toMatchObject({ costUsd: 9, metrics: { llm_calls: 1 } });
  });

  it('数据库层：健管师、伪造协会或机构的会话调用统计函数被拒绝', async () => {
    const db = app.get<Db>(DB);
    const call = (ctx: Parameters<typeof withTenant>[1]) =>
      withTenant(db, ctx, (trx) =>
        sql`select ops_dashboard(current_date - 7, current_date, null)`.execute(trx),
      );
    await expect(
      call({
        userId: f.users.managerA1.id,
        role: 'manager',
        operatorId: f.operatorA,
        orgId: f.orgA,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      call({
        userId: f.users.operatorAdminA.id,
        role: 'operator_admin',
        operatorId: f.operatorB,
        orgId: null,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      call({
        userId: f.users.orgAdminA.id,
        role: 'org_admin',
        operatorId: f.operatorA,
        orgId: f.orgA2,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(
        db,
        {
          userId: f.users.operatorAdminA.id,
          role: 'operator_admin',
          operatorId: f.operatorA,
          orgId: null,
        },
        (trx) => sql`select ops_dashboard(current_date - 200, current_date, null)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  });
});
