import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  withTenant,
  type Db,
  type TenantContext,
  type TenantTransaction,
} from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * 数据库层的隔离测试：直接以应用角色 hb_app 连接，完全绕过仓储层，
 * 证明即使业务代码写错了查询，行级安全也拦得住。
 */
describe('数据库行级安全', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const ctxOf = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ) => ({
    userId: id,
    role,
    operatorId,
    orgId,
  });

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  const managerA1 = () => ctxOf(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);

  it('没有租户上下文时，应用角色查不到任何业务数据', async () => {
    for (const table of [
      'operators',
      'organizations',
      'users',
      'clients',
      'llm_usage',
      'health_reports',
      'report_indicators',
      'monitoring_readings',
    ] as const) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('应用角色读不到会话表和密码哈希', async () => {
    await expect(sql`select * from sessions`.execute(app)).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(app, managerA1(), (trx) =>
        sql`select password_hash from users where id = ${f.users.managerA1.id}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('不带条件的查询也只返回健管师自己的客户', async () => {
    const rows = await withTenant(app, managerA1(), (trx) =>
      trx.selectFrom('clients').select('id').execute(),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...f.clients.a1].sort());
  });

  it('协会A的健管师看不到协会B的任何数据', async () => {
    const seen = await withTenant(app, managerA1(), async (trx) => ({
      client: await trx.selectFrom('clients').select('id').where('id', '=', f.clients.b1).execute(),
      operator: await trx
        .selectFrom('operators')
        .select('id')
        .where('id', '=', f.operatorB)
        .execute(),
      org: await trx.selectFrom('organizations').select('id').where('id', '=', f.orgB).execute(),
      user: await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', f.users.managerB1.id)
        .execute(),
    }));
    expect(seen).toEqual({ client: [], operator: [], org: [], user: [] });
  });

  it('运营商管理员和平台管理员查不到客户明细', async () => {
    const opAdmin = ctxOf(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
    const platform = ctxOf(f.users.platform.id, 'platform_admin', null, null);
    for (const ctx of [opAdmin, platform]) {
      const rows = await withTenant(app, ctx, (trx) =>
        trx.selectFrom('clients').select('id').execute(),
      );
      expect(rows).toHaveLength(0);
    }
  });

  it('机构管理员只看到本机构的客户', async () => {
    const ctx = ctxOf(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
    const rows = await withTenant(app, ctx, (trx) =>
      trx.selectFrom('clients').select('id').execute(),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...f.clients.a1, f.clients.a2].sort());
  });

  it('同一协会内，机构管理员看不到别的机构的客户和健管师', async () => {
    const ctx = ctxOf(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
    const seen = await withTenant(app, ctx, async (trx) => ({
      clients: await trx
        .selectFrom('clients')
        .select('id')
        .where('id', '=', f.clients.a3)
        .execute(),
      users: await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', f.users.managerA3.id)
        .execute(),
      orgs: await trx.selectFrom('organizations').select('id').where('id', '=', f.orgA2).execute(),
    }));
    expect(seen).toEqual({ clients: [], users: [], orgs: [] });
  });

  it('运营商管理员只看到本协会的用户和机构', async () => {
    const ctx = ctxOf(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
    const seen = await withTenant(app, ctx, async (trx) => ({
      users: await trx.selectFrom('users').select('operator_id').execute(),
      orgs: await trx.selectFrom('organizations').select('operator_id').execute(),
      operators: await trx.selectFrom('operators').select('id').execute(),
    }));
    expect(seen.users.length).toBeGreaterThan(0);
    expect(new Set(seen.users.map((u) => u.operator_id))).toEqual(new Set([f.operatorA]));
    expect(new Set(seen.orgs.map((o) => o.operator_id))).toEqual(new Set([f.operatorA]));
    expect(seen.operators.map((o) => o.id)).toEqual([f.operatorA]);
  });

  it('健管师调到别的机构后，客户跟着转过去，原机构管理员看不到', async () => {
    const managerA2 = f.users.managerA2.id;
    await owner.updateTable('users').set({ org_id: f.orgA2 }).where('id', '=', managerA2).execute();
    try {
      const visibleTo = (orgAdmin: string, orgId: string) =>
        withTenant(app, ctxOf(orgAdmin, 'org_admin', f.operatorA, orgId), (trx) =>
          trx.selectFrom('clients').select('id').where('id', '=', f.clients.a2).execute(),
        );
      expect(await visibleTo(f.users.orgAdminA.id, f.orgA)).toHaveLength(0);
      expect(await visibleTo(f.users.orgAdminA2.id, f.orgA2)).toHaveLength(1);
    } finally {
      await owner
        .updateTable('users')
        .set({ org_id: f.orgA })
        .where('id', '=', managerA2)
        .execute();
    }
  });

  it('报告、指标和监测数据跟随客户的可见范围', async () => {
    const tables = ['health_reports', 'report_indicators', 'monitoring_readings'] as const;
    const clientIdsSeenBy = async (ctx: TenantContext) =>
      withTenant(app, ctx, async (trx) => {
        const seen: Record<string, string[]> = {};
        for (const t of tables) {
          const rows = await trx.selectFrom(t).select('client_id').execute();
          seen[t] = rows.map((r) => r.client_id);
        }
        return seen;
      });

    const only = (id: string) => ({
      health_reports: [id],
      report_indicators: [id],
      monitoring_readings: [id],
    });
    const none = { health_reports: [], report_indicators: [], monitoring_readings: [] };

    expect(await clientIdsSeenBy(managerA1())).toEqual(only(f.clients.a1[0]));
    expect(
      await clientIdsSeenBy(ctxOf(f.users.managerB1.id, 'manager', f.operatorB, f.orgB)),
    ).toEqual(only(f.clients.b1));
    expect(
      await clientIdsSeenBy(ctxOf(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA)),
    ).toEqual(only(f.clients.a1[0]));
    // 同协会的其他健管师、其他机构、运营商、平台都看不到
    expect(
      await clientIdsSeenBy(ctxOf(f.users.managerA2.id, 'manager', f.operatorA, f.orgA)),
    ).toEqual(none);
    expect(
      await clientIdsSeenBy(ctxOf(f.users.orgAdminA2.id, 'org_admin', f.operatorA, f.orgA2)),
    ).toEqual(none);
    expect(
      await clientIdsSeenBy(ctxOf(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null)),
    ).toEqual(none);
    expect(await clientIdsSeenBy(ctxOf(f.users.platform.id, 'platform_admin', null, null))).toEqual(
      none,
    );
  });

  it('只有服务该客户的健管师能写入报告和监测数据', async () => {
    // 手动录入要记录录入人（M4 Q29），这里都以当前用户名义录入，只看行级安全是否拦住
    const reading = (clientId: string, createdBy: string) => ({
      client_id: clientId,
      metric: 'weight',
      value: 60,
      unit: 'kg',
      measured_at: new Date(),
      source: 'manual' as const,
      created_by: createdBy,
    });
    const orgAdmin = ctxOf(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
    for (const [ctx, clientId] of [
      [managerA1(), f.clients.b1],
      [managerA1(), f.clients.a2],
      [orgAdmin, f.clients.a1[0]],
    ] as const) {
      await expect(
        withTenant(app, ctx, (trx) =>
          trx.insertInto('monitoring_readings').values(reading(clientId, ctx.userId)).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const deleted = await withTenant(app, managerA1(), (trx) =>
      trx.deleteFrom('health_reports').where('client_id', '=', f.clients.b1).executeTakeFirst(),
    );
    expect(deleted.numDeletedRows).toBe(0n);
    await withTenant(app, managerA1(), (trx) =>
      trx
        .insertInto('monitoring_readings')
        .values(reading(f.clients.a1[0], f.users.managerA1.id))
        .execute(),
    );
  });

  it('不能把报告或监测数据挪到别人的客户名下，也不能挂到别人的报告上', async () => {
    const ownReport = await owner
      .selectFrom('health_reports')
      .select('id')
      .where('client_id', '=', f.clients.a1[0])
      .executeTakeFirstOrThrow();
    const otherReport = await owner
      .selectFrom('health_reports')
      .select('id')
      .where('client_id', '=', f.clients.b1)
      .executeTakeFirstOrThrow();

    const attempts: [string, (trx: TenantTransaction) => Promise<unknown>, string][] = [
      [
        '把监测数据改到 B 的客户',
        (trx) =>
          trx
            .updateTable('monitoring_readings')
            .set({ client_id: f.clients.b1 })
            .where('client_id', '=', f.clients.a1[0])
            .execute(),
        '42501',
      ],
      [
        '把报告改到 B 的客户',
        (trx) =>
          trx
            .updateTable('health_reports')
            .set({ client_id: f.clients.b1 })
            .where('id', '=', ownReport.id)
            .execute(),
        '42501',
      ],
      [
        '给 B 的客户新建报告',
        (trx) =>
          trx
            .insertInto('health_reports')
            .values({
              client_id: f.clients.b1,
              report_date: '2026-02-01',
              title: 'x',
              source: 'manual',
            })
            .execute(),
        '42501',
      ],
      [
        '把指标挂到 B 的报告、填自己的客户',
        (trx) =>
          trx
            .insertInto('report_indicators')
            .values({
              report_id: otherReport.id,
              client_id: f.clients.a1[0],
              code: 'tc',
              value: 5,
              unit: 'mmol/L',
            })
            .execute(),
        '23503',
      ],
      [
        '把指标挂到 B 的报告、填 B 的客户',
        (trx) =>
          trx
            .insertInto('report_indicators')
            .values({
              report_id: otherReport.id,
              client_id: f.clients.b1,
              code: 'tc',
              value: 5,
              unit: 'mmol/L',
            })
            .execute(),
        '42501',
      ],
    ];
    for (const [label, attempt, code] of attempts) {
      await expect(withTenant(app, managerA1(), attempt), label).rejects.toMatchObject({ code });
    }
  });

  it('机构管理员只能看，不能改、不能删本机构客户的数据', async () => {
    const orgAdmin = ctxOf(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
    const result = await withTenant(app, orgAdmin, async (trx) => ({
      updated: await trx
        .updateTable('health_reports')
        .set({ title: 'x' })
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
      deleted: await trx
        .deleteFrom('health_reports')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
      deletedReadings: await trx
        .deleteFrom('monitoring_readings')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
    }));
    expect(result.updated.numUpdatedRows).toBe(0n);
    expect(result.deleted.numDeletedRows).toBe(0n);
    expect(result.deletedReadings.numDeletedRows).toBe(0n);
    // 监测读数（M4 起）对应用角色整体不可修改，录错了删掉重录
    await expect(
      withTenant(app, orgAdmin, (trx) =>
        trx
          .updateTable('monitoring_readings')
          .set({ value: 1 })
          .where('client_id', '=', f.clients.a1[0])
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('健管师改不了、删不了别人的客户', async () => {
    const result = await withTenant(app, managerA1(), async (trx) => ({
      updated: await trx
        .updateTable('clients')
        .set({ display_name: 'x' })
        .where('id', 'in', [f.clients.a2, f.clients.b1])
        .executeTakeFirst(),
      deleted: await trx
        .deleteFrom('clients')
        .where('id', 'in', [f.clients.a2, f.clients.b1])
        .executeTakeFirst(),
    }));
    expect(result.updated.numUpdatedRows).toBe(0n);
    expect(result.deleted.numDeletedRows).toBe(0n);
  });

  it('健管师不能以别人或别的协会的名义新建客户', async () => {
    const attempts = [
      // 挂到同协会的另一位健管师名下
      { operator_id: f.operatorA, org_id: f.orgA, manager_id: f.users.managerA2.id },
      // 挂到协会B
      { operator_id: f.operatorB, org_id: f.orgB, manager_id: f.users.managerA1.id },
      // 挂到别的机构
      { operator_id: f.operatorA, org_id: null, manager_id: f.users.managerA1.id },
    ];
    for (const values of attempts) {
      await expect(
        withTenant(app, managerA1(), (trx) =>
          trx
            .insertInto('clients')
            .values({ ...values, display_name: '测试客户 新' })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('健管师可以在自己名下新建客户', async () => {
    const id = await withTenant(app, managerA1(), async (trx) => {
      const row = await trx
        .insertInto('clients')
        .values({
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
          display_name: '测试客户 新建',
          is_synthetic: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    expect(id).toBeTruthy();
    await owner.deleteFrom('clients').where('id', '=', id).execute();
  });

  it('租户上下文只在事务内有效，不会串到下一次使用同一连接的查询', async () => {
    await withTenant(app, managerA1(), (trx) => trx.selectFrom('clients').select('id').execute());
    // 连接池只有两个连接，连续查询多次必然复用上面那个连接。
    for (let i = 0; i < 4; i++) {
      const rows = await app.selectFrom('clients').select('id').execute();
      expect(rows).toHaveLength(0);
    }
  });
});
