import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Db, type TenantContext } from '../src/db/database.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * 迁移 0017 授予应用角色的表和函数的数据库层隔离测试（M4 规格 7.1、7.2）。
 * 以应用角色 hb_app 直接连接，绕过仓储层：仓储层写错了查询，行级安全和函数里的角色检查也拦得住。
 * 全部是虚构数据。
 */
describe('孪生计算状态、统计和时区（数据库层）', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;
  const today = new Date().toISOString().slice(0, 10);

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA);
  const managerB1 = () => ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB);
  const orgAdminA = () => ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
  const operatorAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);

  /** 执行并返回 Postgres 错误码；成功返回 'ok' */
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      return String((err as { code?: unknown }).code ?? 'unknown');
    }
  };

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = createDb(TEST_APP_URL, 2);
    // A1 的第一位客户、B1 的客户各有一行计算状态
    for (const [clientId, manager, operator, org] of [
      [f.clients.a1[0], f.users.managerA1.id, f.operatorA, f.orgA],
      [f.clients.b1, f.users.managerB1.id, f.operatorB, f.orgB],
    ] as const) {
      await owner
        .insertInto('twin_compute_state')
        .values({
          client_id: clientId,
          operator_id: operator,
          org_id: org,
          manager_id: manager,
          requested_at: new Date(),
        })
        .execute();
    }
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  describe('twin_compute_state 的行级安全', () => {
    it('只有客户的健管师本人能读到；同协会其他健管师、协会 B 健管师、机构管理员、运营商、平台读不到', async () => {
      const own = await withTenant(app, managerA1(), (trx) =>
        trx.selectFrom('twin_compute_state').select('client_id').execute(),
      );
      expect(own.map((r) => r.client_id)).toEqual([f.clients.a1[0]]);

      for (const c of [managerA2(), orgAdminA(), operatorAdminA(), platform()]) {
        const rows = await withTenant(app, c, (trx) =>
          trx.selectFrom('twin_compute_state').select('client_id').execute(),
        );
        expect(rows, c.role).toEqual([]);
      }
      const b = await withTenant(app, managerB1(), (trx) =>
        trx.selectFrom('twin_compute_state').select('client_id').execute(),
      );
      expect(b.map((r) => r.client_id)).toEqual([f.clients.b1]);
    });

    it('别人改不了、写不进：更新影响 0 行，插入被拒绝', async () => {
      for (const c of [managerA2(), managerB1(), orgAdminA(), operatorAdminA(), platform()]) {
        const res = await withTenant(app, c, (trx) =>
          trx
            .updateTable('twin_compute_state')
            .set({ requested_at: new Date(0), computed_at: new Date(0) })
            .where('client_id', '=', f.clients.a1[0])
            .executeTakeFirst(),
        );
        expect(Number(res.numUpdatedRows), c.role).toBe(0);

        const insert = withTenant(app, c, (trx) =>
          trx
            .insertInto('twin_compute_state')
            .values({
              client_id: f.clients.a1[1],
              operator_id: f.operatorA,
              org_id: f.orgA,
              manager_id: f.users.managerA1.id,
              requested_at: new Date(),
            })
            .execute(),
        );
        expect(await codeOf(insert), c.role).toBe('42501');
      }
      const row = await owner
        .selectFrom('twin_compute_state')
        .select(['requested_at'])
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow();
      expect(row.requested_at?.getTime()).not.toBe(0);
    });

    it('租户列写错：别人的客户填自己的租户列被拒绝；自己的客户填别人的租户列按客户改正；不能改租户列、不能删除', async () => {
      const forged = withTenant(app, managerA1(), (trx) =>
        trx
          .insertInto('twin_compute_state')
          .values({
            client_id: f.clients.b1,
            operator_id: f.operatorA,
            org_id: f.orgA,
            manager_id: f.users.managerA1.id,
            requested_at: new Date(),
          })
          .execute(),
      );
      expect(await codeOf(forged)).toBe('42501');

      await withTenant(app, managerA1(), (trx) =>
        trx
          .insertInto('twin_compute_state')
          .values({
            client_id: f.clients.a1[1],
            operator_id: f.operatorB,
            org_id: f.orgB,
            manager_id: f.users.managerB1.id,
            requested_at: new Date(),
          })
          .execute(),
      );
      const stored = await owner
        .selectFrom('twin_compute_state')
        .select(['operator_id', 'org_id', 'manager_id'])
        .where('client_id', '=', f.clients.a1[1])
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
      });

      for (const set of [
        { manager_id: f.users.managerB1.id },
        { operator_id: f.operatorB },
        { org_id: f.orgB },
      ]) {
        const update = withTenant(app, managerA1(), (trx) =>
          trx
            .updateTable('twin_compute_state')
            .set(set)
            .where('client_id', '=', f.clients.a1[1])
            .execute(),
        );
        expect(await codeOf(update), JSON.stringify(Object.keys(set))).toBe('42501');
      }
      const del = withTenant(app, managerA1(), (trx) =>
        trx.deleteFrom('twin_compute_state').where('client_id', '=', f.clients.a1[1]).execute(),
      );
      expect(await codeOf(del)).toBe('42501');
    });
  });

  describe('后台任务专用的函数', () => {
    it('在任何租户上下文里调用都报 insufficient_privilege（42501）', async () => {
      const calls = [
        sql`select * from twin_compute_context(${f.clients.a1[0]}::uuid)`,
        sql`select * from twin_request_all()`,
        sql`select * from twin_pending_clients(false)`,
      ];
      for (const c of [managerA1(), managerB1(), orgAdminA(), operatorAdminA(), platform()]) {
        for (const q of calls) {
          expect(await codeOf(withTenant(app, c, (trx) => q.execute(trx))), c.role).toBe('42501');
        }
      }
    });

    it('没有上下文时（后台任务）只返回身份，不返回业务数据', async () => {
      const { rows } = await sql<Record<string, unknown>>`
        select * from twin_compute_context(${f.clients.a1[0]}::uuid)`.execute(app);
      expect(rows).toEqual([
        {
          user_id: f.users.managerA1.id,
          role: 'manager',
          operator_id: f.operatorA,
          org_id: f.orgA,
        },
      ]);
    });

    it('twin_request_all 不包括健管师已停用的客户（否则会一直显示“正在更新”）', async () => {
      await owner
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', f.users.managerA2.id)
        .execute();
      try {
        const { rows } = await sql<{ twin_request_all: string }>`
          select twin_request_all()`.execute(app);
        const ids = rows.map((r) => r.twin_request_all);
        expect(ids).toContain(f.clients.a1[0]);
        expect(ids).not.toContain(f.clients.a2);
        const state = await owner
          .selectFrom('twin_compute_state')
          .select('client_id')
          .where('client_id', '=', f.clients.a2)
          .execute();
        expect(state).toEqual([]);
      } finally {
        await owner
          .updateTable('users')
          .set({ status: 'active' })
          .where('id', '=', f.users.managerA2.id)
          .execute();
      }
    });
  });

  describe('twin_usage_stats', () => {
    const call = (c: TenantContext | null, operatorId: string | null = null) => {
      const q = sql<Record<string, unknown>>`
        select * from twin_usage_stats(${today}::date, ${today}::date, ${operatorId}::uuid)`;
      return c ? withTenant(app, c, (trx) => q.execute(trx)) : q.execute(app);
    };

    beforeAll(async () => {
      await owner
        .insertInto('twin_usage_daily')
        .values([
          { operator_id: f.operatorA, day: today, opens: 3 },
          { operator_id: f.operatorB, day: today, opens: 5 },
        ])
        .onConflict((oc) => oc.columns(['operator_id', 'day']).doUpdateSet({ opens: 3 }))
        .execute();
    });

    it('跨租户访问被拒绝：没有上下文、健管师、机构管理员直接报错；运营商传别的协会仍只得到本协会', async () => {
      expect(await codeOf(call(null))).toBe('42501');
      expect(await codeOf(call(managerA1()))).toBe('42501');
      expect(await codeOf(call(orgAdminA()))).toBe('42501');

      const { rows } = await call(operatorAdminA(), f.operatorB);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.operator_id).toBe(f.operatorA);
        for (const key of ['manager_id', 'client_id', 'user_id', 'item_id']) {
          expect(r).not.toHaveProperty(key);
        }
      }
      const all = await call(platform());
      expect(new Set(all.rows.map((r) => r.operator_id))).toEqual(
        new Set([f.operatorA, f.operatorB]),
      );
      const filtered = await call(platform(), f.operatorB);
      expect(new Set(filtered.rows.map((r) => r.operator_id))).toEqual(new Set([f.operatorB]));
    });

    it('统计明细表应用角色直接读不到', async () => {
      for (const c of [operatorAdminA(), platform(), managerA1()]) {
        const rows = withTenant(app, c, (trx) =>
          trx
            .selectFrom('twin_usage_daily' as never)
            .selectAll()
            .execute(),
        );
        expect(await codeOf(rows), c.role).toBe('42501');
      }
    });
  });

  describe('twin_record_open', () => {
    it('运营商、平台、没有上下文都被拒绝；健管师只给本协会加一', async () => {
      const q = sql`select twin_record_open()`;
      for (const c of [operatorAdminA(), platform()]) {
        expect(await codeOf(withTenant(app, c, (trx) => q.execute(trx))), c.role).toBe('42501');
      }
      expect(await codeOf(q.execute(app))).toBe('42501');

      const before = await owner.selectFrom('twin_usage_daily').selectAll().execute();
      await withTenant(app, managerA1(), (trx) => q.execute(trx));
      const after = await owner.selectFrom('twin_usage_daily').selectAll().execute();
      const opens = (rows: typeof before, op: string) =>
        rows.filter((r) => r.operator_id === op).reduce((n, r) => n + r.opens, 0);
      expect(opens(after, f.operatorA)).toBe(opens(before, f.operatorA) + 1);
      expect(opens(after, f.operatorB)).toBe(opens(before, f.operatorB));
    });
  });

  describe('user_set_timezone', () => {
    it('只改当前用户自己的一行；没有上下文和不存在的时区报错', async () => {
      await withTenant(app, managerA1(), (trx) =>
        sql`select user_set_timezone(${'Asia/Tokyo'})`.execute(trx),
      );
      const rows = await owner
        .selectFrom('users')
        .select(['id', 'timezone'])
        .where('timezone', 'is not', null)
        .execute();
      expect(rows).toEqual([{ id: f.users.managerA1.id, timezone: 'Asia/Tokyo' }]);

      expect(await codeOf(sql`select user_set_timezone(${'UTC'})`.execute(app))).toBe('42501');
      expect(
        await codeOf(
          withTenant(app, managerA2(), (trx) =>
            sql`select user_set_timezone(${'Mars/Olympus'})`.execute(trx),
          ),
        ),
      ).toBe('22023');
      // 应用角色不能直接改 users.timezone
      expect(
        await codeOf(
          withTenant(app, managerA1(), (trx) =>
            trx
              .updateTable('users')
              .set({ timezone: 'UTC' } as never)
              .where('id', '=', f.users.managerA2.id)
              .execute(),
          ),
        ),
      ).toBe('42501');
      await withTenant(app, managerA1(), (trx) =>
        sql`select user_set_timezone(${null})`.execute(trx),
      );
    });
  });
});
