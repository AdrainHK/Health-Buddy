import { randomBytes, randomUUID } from 'node:crypto';
import {
  COMPANION_DEFAULT_SCRIPTS,
  COMPANION_DEVICE_STATUSES,
  COMPANION_SCRIPT_KINDS,
  COMPANION_VOICE_SPEEDS,
  COMPANION_VOLUMES,
  findBannedTerms,
} from '@health-buddy/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  withDevice,
  withTenant,
  type Db,
  type DeviceContext,
  type TenantContext,
  type TenantTransaction,
} from '../src/db/database.js';
import {
  COMPANION_ENUM_SNAPSHOT_0024,
  COMPANION_SCRIPTS_SNAPSHOT_0024,
} from '../src/db/migrations/0024-companion-devices.js';
import type { Database } from '../src/db/types.js';
import { localDate } from '../src/twin/time-zone.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/** 同意和撤回日期：不能早于告知书发布日期（测试里告知书都是今天发布的） */
const TODAY = localDate(new Date(), 'Asia/Shanghai');
/**
 * M6 伴侣设备、同意、固定话术的数据库层隔离和约束测试（规格 3.4、6.2，验收标准 14、17–20、22）。
 * 以应用角色 hb_app 直接连接，绕过仓储层。全部是虚构数据。
 */
describe('伴侣设备和同意的行级安全', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

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
  const operatorAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);
  const as = <T>(c: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) =>
    withTenant(app, c, fn);

  let batchId: string;
  /** 新的库存设备（以所有者身份写入，相当于平台导入） */
  const stockDevice = async (serial = `SN-${randomUUID().slice(0, 8)}`) =>
    (
      await owner
        .insertInto('companion_devices')
        .values({
          serial_no: serial,
          secret_hash: randomBytes(32),
          activation_code_hash: 'x'.repeat(32),
          batch_id: batchId,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;

  const consent = (c: TenantContext, clientId: string, version = 1) =>
    as(c, (trx) =>
      trx
        .insertInto('companion_consents')
        .values({
          client_id: clientId,
          action: 'consent',
          notice_version: version,
          effective_on: TODAY,
          recorded_by: c.userId,
          chat_data_confirmed: true,
        })
        .execute(),
    );
  const revoke = (c: TenantContext, clientId: string) =>
    as(c, (trx) =>
      trx
        .insertInto('companion_consents')
        .values({
          client_id: clientId,
          action: 'revoke',
          notice_version: null,
          effective_on: TODAY,
          recorded_by: c.userId,
          chat_data_confirmed: true,
        })
        .execute(),
    );
  const call = async (c: TenantContext, fn: ReturnType<typeof sql>) =>
    as(c, async (trx) => {
      const { rows } = await sql<{ r: string }>`select ${fn} as r`.execute(trx);
      return rows[0]?.r;
    });
  const bind = (c: TenantContext, deviceId: string, clientId: string) =>
    call(c, sql`bind_companion_device(${deviceId}::uuid, ${clientId}::uuid)`);
  const deviceRow = (id: string) =>
    owner
      .selectFrom('companion_devices')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const device = (deviceId: string) => ({ deviceId }) satisfies DeviceContext;
  const deviceClient = (deviceId: string) =>
    withDevice(app, device(deviceId), async (trx) => {
      const { rows } = await sql<{ c: string | null }>`select app_client_id() as c`.execute(trx);
      return rows[0]?.c ?? null;
    });

  beforeAll(() => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 4 }),
      }),
    });
  });
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
    // 告知书模板第 1 版（法务正文前用测试文本）
    await owner
      .insertInto('companion_scripts')
      .values({ kind: 'notice', version: 1, text: '测试用告知书' })
      .execute();
    batchId = (
      await owner
        .insertInto('companion_device_batches')
        .values({ name: '测试批次', device_count: 10, imported_by: f.users.platform.id })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
  });

  it('迁移快照和 packages/shared 一致；固定话术没有禁用词', () => {
    expect(COMPANION_ENUM_SNAPSHOT_0024.deviceStatuses).toEqual(COMPANION_DEVICE_STATUSES);
    expect(COMPANION_ENUM_SNAPSHOT_0024.voiceSpeeds).toEqual(COMPANION_VOICE_SPEEDS);
    expect(COMPANION_ENUM_SNAPSHOT_0024.volumes).toEqual(COMPANION_VOLUMES);
    expect(COMPANION_ENUM_SNAPSHOT_0024.scriptKinds).toEqual(COMPANION_SCRIPT_KINDS);
    expect(COMPANION_SCRIPTS_SNAPSHOT_0024).toEqual(COMPANION_DEFAULT_SCRIPTS);
    for (const text of Object.values(COMPANION_DEFAULT_SCRIPTS)) {
      expect(findBannedTerms(text)).toEqual([]);
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });

  it('绑定：要有有效同意；只能绑自己的客户；设备和客户都只能绑一次', async () => {
    const d1 = await stockDevice();
    const d2 = await stockDevice();
    const [c1, c2] = f.clients.a1;
    expect(await bind(managerA1(), d1, c1)).toBe('no_consent');
    await consent(managerA1(), c1);
    // 别人的客户、非健管师角色
    expect(await bind(managerA2(), d1, c1)).toBe('not_found');
    expect(await bind(managerB1(), d1, c1)).toBe('not_found');
    expect(await bind(orgAdminA(), d1, c1)).toBe('not_found');
    expect(await bind(platform(), d1, c1)).toBe('not_found');
    expect(await bind(managerA1(), d1, c1)).toBe('ok');
    const row = await deviceRow(d1);
    expect(row).toMatchObject({
      status: 'bound',
      client_id: c1,
      manager_id: f.users.managerA1.id,
      operator_id: f.operatorA,
      org_id: f.orgA,
      bound_by: f.users.managerA1.id,
    });
    expect(await bind(managerA1(), d2, c1)).toBe('already_bound');
    await consent(managerA1(), c2);
    expect(await bind(managerA1(), d1, c2)).toBe('unavailable');
    expect(await bind(managerA1(), randomUUID(), c2)).toBe('unavailable');
  });

  it('读设备：只有绑定它的健管师和这台设备自己；其他角色、别的健管师都读不到', async () => {
    const d1 = await stockDevice();
    const d2 = await stockDevice();
    const c1 = f.clients.a1[0];
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    const count = (c: TenantContext) =>
      as(
        c,
        async (trx) => (await trx.selectFrom('companion_devices').select('id').execute()).length,
      );
    expect(await count(managerA1())).toBe(1);
    for (const c of [
      managerA2(),
      managerA3(),
      managerB1(),
      orgAdminA(),
      operatorAdminA(),
      platform(),
    ]) {
      expect(await count(c)).toBe(0);
    }
    const ids = await withDevice(app, device(d1), async (trx) =>
      (await trx.selectFrom('companion_devices').select('id').execute()).map((r) => r.id),
    );
    expect(ids).toEqual([d1]);
    // 库存设备没有任何人能读
    expect(
      await withDevice(app, device(d2), async (trx) =>
        trx.selectFrom('companion_devices').select('id').where('id', '=', d1).execute(),
      ),
    ).toEqual([]);
  });

  it('设备角色读不到任何已有的客户数据表（验收标准 20）', async () => {
    const d1 = await stockDevice();
    const c1 = f.clients.a1[0];
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    // 这位客户和所属协会、机构在这些表里确实有数据（不是空表测空表）
    for (const [table, column, value] of [
      ['clients', 'id', c1],
      ['health_reports', 'client_id', c1],
      ['report_indicators', 'client_id', c1],
      ['monitoring_readings', 'client_id', c1],
      ['companion_consents', 'client_id', c1],
      ['operators', 'id', f.operatorA],
      ['organizations', 'id', f.orgA],
      ['users', 'id', f.users.managerA1.id],
    ] as const) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from ${sql.table(table)} where ${sql.ref(column)} = ${value}
      `.execute(owner);
      expect({ table, n: rows[0]?.n }).toEqual({ table, n: 1 });
    }
    // 所有开启了行级安全的表逐张查：除了平台级的参考数据（没有任何客户、租户数据），设备一行都读不到
    const PLATFORM_REFERENCE = new Set([
      'companion_scripts',
      'critical_thresholds',
      'twin_status_rules',
      'twin_rules_version',
      'plan_library_recipes',
      'plan_library_exercises',
      'plan_goal_templates',
      'visit_frequency_rules',
      'visit_frequency_config',
      'visit_frequency_version',
      'expert_availability',
    ]);
    const { rows } = await sql<{ relname: string }>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      order by c.relname
    `.execute(owner);
    const tables = rows.map((r) => r.relname);
    expect(tables).toEqual(
      expect.arrayContaining(['clients', 'health_reports', 'companion_consents']),
    );
    const readable: string[] = [];
    for (const table of tables) {
      const n = await withDevice(app, device(d1), async (trx) => {
        try {
          const r = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.table(table)}
          `.execute(trx);
          return r.rows[0]?.n ?? 0;
        } catch (e) {
          // 只有“没有权限”算读不到，其他错误（表名写错等）直接失败
          if ((e as { code?: string }).code === '42501') return 0;
          throw e;
        }
      });
      if (table === 'companion_devices') expect(n).toBe(1);
      else if (n > 0) readable.push(table);
    }
    expect(readable.filter((t) => !PLATFORM_REFERENCE.has(t))).toEqual([]);
    expect(readable).toContain('companion_scripts');
  });

  it('设备的客户由数据库按设备行查出：解绑后为空，再绑给别人后是新客户', async () => {
    const d1 = await stockDevice();
    const c1 = f.clients.a1[0];
    expect(await deviceClient(d1)).toBeNull();
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    expect(await deviceClient(d1)).toBe(c1);
    // 健管师会话里 app_client_id() 永远为空
    expect(
      await as(managerA1(), async (trx) => {
        const { rows } = await sql<{ c: string | null }>`select app_client_id() as c`.execute(trx);
        return rows[0]?.c;
      }),
    ).toBeNull();
    await call(managerA1(), sql`unbind_companion_device(${c1}::uuid)`);
    expect(await deviceClient(d1)).toBeNull();
    await consent(managerB1(), f.clients.b1);
    await bind(managerB1(), d1, f.clients.b1);
    expect(await deviceClient(d1)).toBe(f.clients.b1);
    // 撤回同意后仍是这位客户（只播暂停话术），不会落到别人
    await revoke(managerB1(), f.clients.b1);
    expect(await deviceClient(d1)).toBe(f.clients.b1);
  });

  it('应用角色读不到设备的两个哈希列', async () => {
    const d1 = await stockDevice();
    await consent(managerA1(), f.clients.a1[0]);
    await bind(managerA1(), d1, f.clients.a1[0]);
    await expect(
      as(managerA1(), (trx) => sql`select secret_hash from companion_devices`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withDevice(app, device(d1), (trx) =>
        sql`select activation_code_hash from companion_devices`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('应用角色不能直接改、删设备，不能直接插入已绑定的设备', async () => {
    const d1 = await stockDevice();
    await expect(
      as(platform(), (trx) =>
        sql`update companion_devices set status = 'active' where id = ${d1}`.execute(trx),
      ),
    ).rejects.toThrow();
    await expect(
      as(platform(), (trx) => sql`delete from companion_devices where id = ${d1}`.execute(trx)),
    ).rejects.toThrow();
    await expect(
      as(managerA1(), (trx) =>
        trx
          .insertInto('companion_devices')
          .values({
            serial_no: 'SN-MANAGER',
            secret_hash: randomBytes(32),
            activation_code_hash: 'x'.repeat(32),
            batch_id: batchId,
          })
          .execute(),
      ),
    ).rejects.toThrow();
    // 平台可以导入库存设备
    await as(platform(), (trx) =>
      trx
        .insertInto('companion_devices')
        .values({
          serial_no: 'SN-PLATFORM',
          secret_hash: randomBytes(32),
          activation_code_hash: 'x'.repeat(32),
          batch_id: batchId,
        })
        .execute(),
    );
  });

  it('同意记录：只能追加；版本必须存在；撤回前必须有同意；只有服务客户的健管师能记', async () => {
    const c1 = f.clients.a1[0];
    await expect(consent(managerA1(), c1, 9)).rejects.toThrow();
    await expect(revoke(managerA1(), c1)).rejects.toThrow();
    // 别人的客户一律“没有权限”，不能借报错判断对方有没有有效同意
    await expect(consent(managerA2(), c1)).rejects.toMatchObject({ code: '42501' });
    await expect(revoke(managerA2(), c1)).rejects.toMatchObject({ code: '42501' });
    await expect(consent(managerB1(), c1)).rejects.toThrow();
    await consent(managerA1(), c1);
    const rows = await as(managerA1(), (trx) =>
      trx.selectFrom('companion_consents').selectAll().execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operator_id: f.operatorA, org_id: f.orgA });
    for (const c of [managerA2(), managerB1(), orgAdminA(), operatorAdminA(), platform()]) {
      expect(
        await as(c, (trx) => trx.selectFrom('companion_consents').select('id').execute()),
      ).toEqual([]);
    }
    await expect(
      as(managerA1(), (trx) =>
        sql`update companion_consents set notice_version = 1 where client_id = ${c1}`.execute(trx),
      ),
    ).rejects.toThrow();
    await expect(
      as(managerA1(), (trx) =>
        sql`delete from companion_consents where client_id = ${c1}`.execute(trx),
      ),
    ).rejects.toThrow();
  });

  it('撤回同意 → 设备 revoked；重新同意 → 恢复；暂停和恢复', async () => {
    const d1 = await stockDevice();
    const c1 = f.clients.a1[0];
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    await owner
      .updateTable('companion_devices')
      .set({ activated_at: new Date(), status: 'active' } as never)
      .where('id', '=', d1)
      .execute();
    const pause = (c: TenantContext, p: boolean) =>
      call(c, sql`set_companion_device_paused(${c1}::uuid, ${p})`);
    expect(await pause(managerA2(), true)).toBe('not_found');
    expect(await pause(managerA1(), true)).toBe('ok');
    expect((await deviceRow(d1)).status).toBe('paused');
    expect(await pause(managerA1(), false)).toBe('ok');
    expect((await deviceRow(d1)).status).toBe('active');
    await revoke(managerA1(), c1);
    expect((await deviceRow(d1)).status).toBe('revoked');
    expect(await pause(managerA1(), false)).toBe('invalid_state');
    await consent(managerA1(), c1);
    expect((await deviceRow(d1)).status).toBe('active');
    expect(
      await call(managerA1(), sql`set_companion_device_paused(${f.clients.a1[1]}::uuid, true)`),
    ).toBe('no_device');
  });

  it('解绑：设备回到库存，不留客户和租户；别人的客户 not_found', async () => {
    const d1 = await stockDevice();
    const c1 = f.clients.a1[0];
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    expect(await call(managerB1(), sql`unbind_companion_device(${c1}::uuid)`)).toBe('not_found');
    expect(await call(managerA1(), sql`unbind_companion_device(${c1}::uuid)`)).toBe('ok');
    expect(await deviceRow(d1)).toMatchObject({
      status: 'stock',
      client_id: null,
      manager_id: null,
      operator_id: null,
      org_id: null,
      bound_by: null,
      bound_at: null,
    });
    expect(await call(managerA1(), sql`unbind_companion_device(${c1}::uuid)`)).toBe('no_device');
    // 再绑给别的协会的客户
    await consent(managerB1(), f.clients.b1);
    expect(await bind(managerB1(), d1, f.clients.b1)).toBe('ok');
  });

  it('客户转给别的健管师、换机构时设备和同意跟着走；删除客户时设备回到库存', async () => {
    const d1 = await stockDevice();
    const c1 = f.clients.a1[0];
    await consent(managerA1(), c1);
    await bind(managerA1(), d1, c1);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
      .where('id', '=', c1)
      .execute();
    expect(await deviceRow(d1)).toMatchObject({
      manager_id: f.users.managerA3.id,
      org_id: f.orgA2,
    });
    const consents = await owner
      .selectFrom('companion_consents')
      .select(['manager_id', 'org_id'])
      .where('client_id', '=', c1)
      .execute();
    expect(consents).toEqual([{ manager_id: f.users.managerA3.id, org_id: f.orgA2 }]);
    expect(
      await as(managerA1(), (trx) => trx.selectFrom('companion_devices').select('id').execute()),
    ).toEqual([]);
    expect(
      await as(managerA1(), (trx) => trx.selectFrom('companion_consents').select('id').execute()),
    ).toEqual([]);
    expect(
      (await as(managerA3(), (trx) => trx.selectFrom('companion_devices').select('id').execute()))
        .length,
    ).toBe(1);

    await owner.deleteFrom('clients').where('id', '=', c1).execute();
    expect(await deviceRow(d1)).toMatchObject({ status: 'stock', client_id: null });
  });

  it('平台：批次统计只给平台、不含客户；查已存在序列号只给平台', async () => {
    const d1 = await stockDevice('SN-EXIST-1');
    await stockDevice('SN-EXIST-2');
    await consent(managerA1(), f.clients.a1[0]);
    await bind(managerA1(), d1, f.clients.a1[0]);
    const stats = (c: TenantContext) =>
      as(
        c,
        async (trx) => (await sql`select * from companion_device_batch_stats()`.execute(trx)).rows,
      );
    expect(await stats(platform())).toEqual([
      expect.objectContaining({ name: '测试批次', device_count: 10, bound_count: 1 }),
    ]);
    expect(Object.keys((await stats(platform()))[0] as object).sort()).toEqual(
      ['bound_count', 'device_count', 'id', 'imported_at', 'name'].sort(),
    );
    expect(await stats(managerA1())).toEqual([]);
    const existing = (c: TenantContext) =>
      as(c, async (trx) =>
        (
          await sql<{ s: string }>`select s from companion_existing_serials(${[
            'SN-EXIST-1',
            'SN-NEW',
          ]}::text[]) as s`.execute(trx)
        ).rows.map((r) => r.s),
      );
    expect(await existing(platform())).toEqual(['SN-EXIST-1']);
    expect(await existing(managerA1())).toEqual([]);
    // 绑定前查设备只给健管师
    const forBinding = (c: TenantContext) =>
      as(
        c,
        async (trx) =>
          (await sql`select * from companion_device_for_binding('SN-EXIST-2')`.execute(trx)).rows,
      );
    expect(await forBinding(managerB1())).toHaveLength(1);
    // 已绑定的设备不返回任何行（不暴露状态和激活码哈希）
    expect(
      await as(
        managerB1(),
        async (trx) =>
          (await sql`select * from companion_device_for_binding('SN-EXIST-1')`.execute(trx)).rows,
      ),
    ).toEqual([]);
    expect(await forBinding(platform())).toEqual([]);
    expect(await forBinding(orgAdminA())).toEqual([]);
  });

  it('固定话术：只能追加，版本号按种类加一；只有平台能写；所有后台角色和设备能读', async () => {
    const save = (c: TenantContext) =>
      as(c, (trx) =>
        trx
          .insertInto('companion_scripts')
          .values({ kind: 'crisis', text: '测试新版本', created_by: c.userId })
          .returning('version')
          .executeTakeFirstOrThrow(),
      );
    expect((await save(platform())).version).toBe(2);
    expect((await save(platform())).version).toBe(3);
    await expect(save(managerA1())).rejects.toThrow();
    await expect(save(operatorAdminA())).rejects.toThrow();
    await expect(
      as(platform(), (trx) => sql`update companion_scripts set text = 'x'`.execute(trx)),
    ).rejects.toThrow();
    await expect(
      as(platform(), (trx) => sql`delete from companion_scripts`.execute(trx)),
    ).rejects.toThrow();
    // 念出来的话术不超过 300 字
    await expect(
      as(platform(), (trx) =>
        trx
          .insertInto('companion_scripts')
          .values({ kind: 'crisis', text: '长'.repeat(301), created_by: platform().userId })
          .execute(),
      ),
    ).rejects.toThrow();
    for (const c of [managerA1(), orgAdminA(), operatorAdminA()]) {
      const n = await as(
        c,
        async (trx) => (await trx.selectFrom('companion_scripts').select('id').execute()).length,
      );
      expect(n).toBeGreaterThan(0);
    }
  });
});
