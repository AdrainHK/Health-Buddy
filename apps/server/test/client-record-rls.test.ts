import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * M2 客户档案数据表的数据库层隔离和约束测试（规格 3.1、3.2，验收标准 20、21）。
 * 以应用角色 hb_app 直接连接，绕过仓储层。
 */
describe('客户档案数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const RECORD_TABLES = [
    'health_reports',
    'report_indicators',
    'client_health_history',
    'client_risk_tiers',
  ] as const;

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA);
  const managerA3 = () => ctx(f.users.managerA3.id, 'manager', f.operatorA, f.orgA2);
  const managerB1 = () => ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB);
  const orgAdminA = () => ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
  const orgAdminA2 = () => ctx(f.users.orgAdminA2.id, 'org_admin', f.operatorA, f.orgA2);
  const operatorAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);

  const asA1 = <T>(fn: (trx: TenantTransaction) => Promise<T>) => withTenant(app, managerA1(), fn);

  const historyRow = (clientId: string, createdBy = f.users.managerA1.id) => ({
    operator_id: f.operatorA,
    org_id: f.orgA,
    manager_id: f.users.managerA1.id,
    client_id: clientId,
    category: 'lifestyle' as const,
    content: '合成记录：每周快走三次',
    created_by: createdBy,
  });
  const tierRow = (clientId: string, setBy = f.users.managerA1.id) => ({
    operator_id: f.operatorA,
    org_id: f.orgA,
    manager_id: f.users.managerA1.id,
    client_id: clientId,
    tier: 'medium' as const,
    reason: '合成理由',
    set_by: setBy,
  });

  /** 以所有者身份给客户写一条健康史和一条分层（全部是虚构数据） */
  async function seedRecord(clientId: string) {
    const client = await owner
      .selectFrom('clients')
      .select(['operator_id', 'org_id', 'manager_id'])
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    await owner
      .insertInto('client_health_history')
      .values({
        ...client,
        client_id: clientId,
        category: 'allergy',
        content: '合成记录：青霉素过敏',
        created_by: client.manager_id,
      })
      .execute();
    await owner
      .insertInto('client_risk_tiers')
      .values({
        ...client,
        client_id: clientId,
        tier: 'low',
        reason: '合成理由',
        set_by: client.manager_id,
      })
      .execute();
  }

  beforeAll(async () => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    for (const clientId of [f.clients.a1[0], f.clients.a2, f.clients.a3, f.clients.b1]) {
      await seedRecord(clientId);
    }
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  async function clientIdsSeenBy(c: TenantContext) {
    return withTenant(app, c, async (trx) => {
      const seen: Record<string, string[]> = {};
      for (const t of RECORD_TABLES) {
        const rows = await trx.selectFrom(t).select('client_id').execute();
        seen[t] = [...new Set(rows.map((r) => r.client_id))].sort();
      }
      return seen;
    });
  }
  const each = (ids: string[], tables: readonly string[] = RECORD_TABLES) =>
    Object.fromEntries(RECORD_TABLES.map((t) => [t, tables.includes(t) ? [...ids].sort() : []]));

  it('没有租户上下文时，应用角色查不到任何档案数据', async () => {
    for (const table of RECORD_TABLES) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('已有报告和指标按客户回填了租户列', async () => {
    for (const table of ['health_reports', 'report_indicators'] as const) {
      const rows = await owner
        .selectFrom(`${table} as r`)
        .innerJoin('clients as c', 'c.id', 'r.client_id')
        .select([
          'r.operator_id',
          'r.org_id',
          'r.manager_id',
          'c.operator_id as c_operator',
          'c.org_id as c_org',
          'c.manager_id as c_manager',
        ])
        .execute();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect([r.operator_id, r.org_id, r.manager_id]).toEqual([
          r.c_operator,
          r.c_org,
          r.c_manager,
        ]);
      }
    }
  });

  it('逐表：健管师只看到自己客户的档案，其他健管师、协会、运营商和平台都看不到', async () => {
    const reportClients = [f.clients.a1[0], f.clients.b1];
    const withReports = (clientId: string) =>
      Object.fromEntries(
        RECORD_TABLES.map((t) => [
          t,
          t.startsWith('client_') || reportClients.includes(clientId) ? [clientId] : [],
        ]),
      );
    expect(await clientIdsSeenBy(managerA1())).toEqual(withReports(f.clients.a1[0]));
    expect(await clientIdsSeenBy(managerB1())).toEqual(withReports(f.clients.b1));
    expect(await clientIdsSeenBy(managerA2())).toEqual(withReports(f.clients.a2));
    expect(await clientIdsSeenBy(operatorAdminA())).toEqual(each([]));
    expect(await clientIdsSeenBy(platform())).toEqual(each([]));
  });

  it('机构管理员只读本机构客户的档案，看不到别的机构和已删除的健康史', async () => {
    const seen = await clientIdsSeenBy(orgAdminA());
    expect(seen).toEqual({
      health_reports: [f.clients.a1[0]],
      report_indicators: [f.clients.a1[0]],
      client_health_history: [f.clients.a1[0], f.clients.a2].sort(),
      client_risk_tiers: [f.clients.a1[0], f.clients.a2].sort(),
    });
    expect(await clientIdsSeenBy(orgAdminA2())).toEqual({
      ...each([]),
      client_health_history: [f.clients.a3],
      client_risk_tiers: [f.clients.a3],
    });

    await owner
      .updateTable('client_health_history')
      .set({ deleted_at: new Date() })
      .where('client_id', '=', f.clients.a2)
      .execute();
    const after = await clientIdsSeenBy(orgAdminA());
    expect(after.client_health_history).toEqual([f.clients.a1[0]]);

    // 只读：改不了、删不了，以自己的名义也写不进
    const result = await withTenant(app, orgAdminA(), async (trx) => ({
      history: await trx
        .updateTable('client_health_history')
        .set({ content: 'x' })
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
      reports: await trx
        .updateTable('health_reports')
        .set({ title: 'x' })
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
      indicators: await trx
        .deleteFrom('report_indicators')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirst(),
    }));
    expect(result.history.numUpdatedRows).toBe(0n);
    expect(result.reports.numUpdatedRows).toBe(0n);
    expect(result.indicators.numDeletedRows).toBe(0n);
    for (const insert of [
      (trx: TenantTransaction) =>
        trx
          .insertInto('client_health_history')
          .values(historyRow(f.clients.a1[0], f.users.orgAdminA.id))
          .execute(),
      (trx: TenantTransaction) =>
        trx
          .insertInto('client_risk_tiers')
          .values(tierRow(f.clients.a1[0], f.users.orgAdminA.id))
          .execute(),
    ]) {
      await expect(withTenant(app, orgAdminA(), insert)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('健管师不能给别人的客户写健康史和分层', async () => {
    for (const clientId of [f.clients.a2, f.clients.b1, f.clients.a3]) {
      await expect(
        asA1((trx) =>
          trx.insertInto('client_health_history').values(historyRow(clientId)).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) => trx.insertInto('client_risk_tiers').values(tierRow(clientId)).execute()),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('请求里给错租户列也没用：租户列按客户填写', async () => {
    const row = await asA1((trx) =>
      trx
        .insertInto('client_health_history')
        .values({ ...historyRow(f.clients.a1[1]), org_id: null })
        .returning(['operator_id', 'org_id', 'manager_id'])
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({
      operator_id: f.operatorA,
      org_id: f.orgA,
      manager_id: f.users.managerA1.id,
    });
  });

  it('不能冒用别人的名义新增健康史或设定分层', async () => {
    await expect(
      asA1((trx) =>
        trx
          .insertInto('client_health_history')
          .values(historyRow(f.clients.a1[0], f.users.managerA2.id))
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asA1((trx) =>
        trx
          .insertInto('client_risk_tiers')
          .values(tierRow(f.clients.a1[0], f.users.managerA2.id))
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('分层历史只能追加：直接修改或删除被拒绝', async () => {
    await expect(
      asA1((trx) =>
        trx
          .updateTable('client_risk_tiers')
          .set({ tier: 'high' })
          .where('client_id', '=', f.clients.a1[0])
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asA1((trx) =>
        trx.deleteFrom('client_risk_tiers').where('client_id', '=', f.clients.a1[0]).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 设定时间由数据库决定，不能回填
    const row = await asA1((trx) =>
      trx
        .insertInto('client_risk_tiers')
        .values({ ...tierRow(f.clients.a1[0]), set_at: '2000-01-01T00:00:00Z' })
        .returning('set_at')
        .executeTakeFirstOrThrow(),
    );
    expect(row.set_at.getFullYear()).toBeGreaterThan(2000);
  });

  it('分层历史的触发器：即使有了修改权限也改不了', async () => {
    // 模拟以后误授了 update/delete：触发器仍然拦住
    await sql`grant update, delete on client_risk_tiers to hb_app`.execute(owner);
    try {
      await expect(
        asA1((trx) =>
          trx
            .updateTable('client_risk_tiers')
            .set({ reason: 'x' })
            .where('client_id', '=', f.clients.a1[0])
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) =>
          trx.deleteFrom('client_risk_tiers').where('client_id', '=', f.clients.a1[0]).execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await sql`revoke update, delete on client_risk_tiers from hb_app`.execute(owner);
    }
  });

  it('健康史：不能删除、不能挪到别的客户，已删除的条目不能再改', async () => {
    await expect(
      asA1((trx) =>
        trx.deleteFrom('client_health_history').where('client_id', '=', f.clients.a1[0]).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asA1((trx) =>
        trx
          .updateTable('client_health_history')
          .set({ client_id: f.clients.a1[1] })
          .where('client_id', '=', f.clients.a1[0])
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asA1((trx) =>
        trx
          .updateTable('client_health_history')
          .set({ manager_id: f.users.managerA2.id })
          .where('client_id', '=', f.clients.a1[0])
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await asA1((trx) =>
      trx
        .updateTable('client_health_history')
        .set({ deleted_at: new Date() })
        .where('client_id', '=', f.clients.a1[0])
        .execute(),
    );
    for (const set of [{ deleted_at: null }, { content: '改回来' }]) {
      await expect(
        asA1((trx) =>
          trx
            .updateTable('client_health_history')
            .set(set)
            .where('client_id', '=', f.clients.a1[0])
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('健管师改不了别人客户的健康史', async () => {
    const result = await asA1((trx) =>
      trx
        .updateTable('client_health_history')
        .set({ content: 'x' })
        .where('client_id', 'in', [f.clients.a2, f.clients.b1])
        .executeTakeFirst(),
    );
    expect(result.numUpdatedRows).toBe(0n);
  });

  it('客户转给同机构的健管师：报告、指标、健康史、分层跟着转，原健管师看不到', async () => {
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const a1 = await clientIdsSeenBy(managerA1());
    expect(a1).toEqual(each([]));
    const a2 = await clientIdsSeenBy(managerA2());
    for (const t of RECORD_TABLES) expect(a2[t], t).toContain(f.clients.a1[0]);
    // 历史分层记录保留，设定人仍是原健管师
    const tiers = await withTenant(app, managerA2(), (trx) =>
      trx
        .selectFrom('client_risk_tiers')
        .select(['set_by', 'manager_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute(),
    );
    expect(tiers).toEqual([{ set_by: f.users.managerA1.id, manager_id: f.users.managerA2.id }]);
  });

  it('客户转到别的机构：档案数据的 org_id 跟着变，两边的机构管理员各自看到对的数据', async () => {
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
      .where('id', '=', f.clients.a1[0])
      .execute();
    for (const table of RECORD_TABLES) {
      const rows = await owner
        .selectFrom(table)
        .select(['manager_id', 'org_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r, table).toEqual({ manager_id: f.users.managerA3.id, org_id: f.orgA2 });
      }
    }
    const orgA = await clientIdsSeenBy(orgAdminA());
    const orgA2 = await clientIdsSeenBy(orgAdminA2());
    const a3 = await clientIdsSeenBy(managerA3());
    for (const t of RECORD_TABLES) {
      expect(orgA[t], t).not.toContain(f.clients.a1[0]);
      expect(orgA2[t], t).toContain(f.clients.a1[0]);
      expect(a3[t], t).toContain(f.clients.a1[0]);
    }
  });

  it('健管师调机构：档案数据的 org_id 跟着变', async () => {
    await owner
      .updateTable('users')
      .set({ org_id: f.orgA2 })
      .where('id', '=', f.users.managerA1.id)
      .execute();
    for (const table of RECORD_TABLES) {
      const rows = await owner
        .selectFrom(table)
        .select('org_id')
        .where('manager_id', '=', f.users.managerA1.id)
        .execute();
      expect(rows.length, table).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.org_id)), table).toEqual(new Set([f.orgA2]));
    }
    const seen = await clientIdsSeenBy(orgAdminA());
    for (const t of RECORD_TABLES) expect(seen[t], t).not.toContain(f.clients.a1[0]);
  });

  it('客户删除时档案数据一起删除（包括只能追加的分层历史）', async () => {
    await owner.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute();
    for (const table of RECORD_TABLES) {
      const rows = await owner
        .selectFrom(table)
        .select('id')
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  describe('报告和指标的写入', () => {
    /** 以所有者身份给客户建一份报告，返回 id */
    const reportOf = async (clientId: string) =>
      (
        await owner
          .insertInto('health_reports')
          .values({
            client_id: clientId,
            report_date: '2026-03-01',
            title: '合成报告',
            source: 'synthetic',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id as string;
    const report = (clientId: string) => ({
      client_id: clientId,
      report_date: '2026-04-01',
      title: '合成报告',
      source: 'manual' as const,
    });
    const indicator = (reportId: string, clientId: string) => ({
      report_id: reportId,
      client_id: clientId,
      code: 'tc',
      value: 5,
      unit: 'mmol/L',
    });

    it('健管师不能给同协会其他健管师或协会B的客户写报告和指标', async () => {
      for (const clientId of [f.clients.a2, f.clients.b1, f.clients.a3]) {
        const otherReport = await reportOf(clientId);
        await expect(
          asA1((trx) => trx.insertInto('health_reports').values(report(clientId)).execute()),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          asA1((trx) =>
            trx.insertInto('report_indicators').values(indicator(otherReport, clientId)).execute(),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('不能把自己的报告或指标改到别人的客户名下，也不能改租户列', async () => {
      const own = await owner
        .selectFrom('health_reports')
        .select('id')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow();
      const attempts: ((trx: TenantTransaction) => Promise<unknown>)[] = [
        (trx) =>
          trx
            .updateTable('health_reports')
            .set({ client_id: f.clients.a2 })
            .where('id', '=', own.id)
            .execute(),
        (trx) =>
          trx
            .updateTable('report_indicators')
            .set({ client_id: f.clients.a2 })
            .where('report_id', '=', own.id)
            .execute(),
        (trx) =>
          trx
            .updateTable('health_reports')
            .set({ manager_id: f.users.managerA2.id })
            .where('id', '=', own.id)
            .execute(),
        (trx) =>
          trx
            .updateTable('report_indicators')
            .set({ org_id: f.orgA2 })
            .where('report_id', '=', own.id)
            .execute(),
      ];
      for (const attempt of attempts) {
        await expect(asA1(attempt)).rejects.toMatchObject({ code: '42501' });
      }
      // 内容列仍可修改
      const updated = await asA1((trx) =>
        trx
          .updateTable('report_indicators')
          .set({ value: 5.6 })
          .where('report_id', '=', own.id)
          .executeTakeFirst(),
      );
      expect(updated.numUpdatedRows).toBe(1n);
    });

    it('机构管理员不能写报告和指标', async () => {
      const own = await owner
        .selectFrom('health_reports')
        .select('id')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow();
      await expect(
        withTenant(app, orgAdminA(), (trx) =>
          trx.insertInto('health_reports').values(report(f.clients.a1[0])).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(app, orgAdminA(), (trx) =>
          trx.insertInto('report_indicators').values(indicator(own.id, f.clients.a1[0])).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('客户的机构变了而健管师没变：档案数据的租户列跟着同步', async () => {
    // 外键 (manager_id, org_id) 在 org_id 为空时不检查，借此单独改客户的机构
    await owner
      .updateTable('clients')
      .set({ org_id: null })
      .where('id', '=', f.clients.a1[0])
      .execute();
    for (const table of RECORD_TABLES) {
      const rows = await owner
        .selectFrom(table)
        .select(['org_id', 'operator_id', 'manager_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r, table).toEqual({
          org_id: null,
          operator_id: f.operatorA,
          manager_id: f.users.managerA1.id,
        });
      }
    }
    const seen = await clientIdsSeenBy(orgAdminA());
    for (const t of RECORD_TABLES) expect(seen[t], t).not.toContain(f.clients.a1[0]);
  });
});
