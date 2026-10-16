import { randomBytes, randomUUID } from 'node:crypto';
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
import { ReportsRepository } from '../src/reports/reports.repository.js';
import { InMemoryObjectStorage } from '../src/reports/storage.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * 报告上传相关数据表的数据库层隔离和约束（M2 规格 3.1、3.2，验收标准 20、21）。
 * 以应用角色 hb_app 直接连接，绕过仓储层。全部是虚构数据。
 */
describe('报告上传数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const UPLOAD_TABLES = [
    'report_uploads',
    'report_files',
    'extracted_values',
    'report_events',
  ] as const;
  const ALL_TABLES = [...UPLOAD_TABLES, 'health_reports', 'report_indicators'] as const;

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

  const asA1 = <T>(fn: (trx: TenantTransaction) => Promise<T>) => withTenant(app, managerA1(), fn);

  const scope = (c: TenantContext) => ({
    operator_id: c.operatorId!,
    org_id: c.orgId,
    manager_id: c.userId,
  });

  /** 以健管师身份走一遍：上传 → 识别中 → 写入识别结果 → 待核对。返回各行 id */
  async function seedUpload(c: TenantContext, clientId: string) {
    return withTenant(app, c, async (trx) => {
      const upload = await trx
        .insertInto('report_uploads')
        .values({
          ...scope(c),
          client_id: clientId,
          page_count: 1,
          uploaded_by: c.userId,
          requested_by: c.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const file = await trx
        .insertInto('report_files')
        .values({
          ...scope(c),
          client_id: clientId,
          upload_id: upload.id,
          seq: 0,
          storage_key: `reports/${randomBytes(16).toString('hex')}`,
          mime_type: 'image/png',
          size_bytes: 100,
          page_count: 1,
          sha256: randomBytes(32).toString('hex'),
          original_name: 'synthetic.png',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('report_events')
        .values({
          ...scope(c),
          client_id: clientId,
          upload_id: upload.id,
          actor_id: c.userId,
          action: 'uploaded',
        })
        .execute();
      await trx
        .updateTable('report_uploads')
        .set({ status: 'processing' })
        .where('id', '=', upload.id)
        .execute();
      const value = await trx
        .insertInto('extracted_values')
        .values({
          ...scope(c),
          client_id: clientId,
          upload_id: upload.id,
          seq: 0,
          raw_name: '空腹血糖',
          code: 'fpg',
          raw_value: '5.1',
          raw_unit: 'mmol/L',
          value: 5.1,
          unit: 'mmol/L',
          page: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('report_uploads')
        .set({ status: 'needs_review', version: 1 })
        .where('id', '=', upload.id)
        .execute();
      return { uploadId: upload.id, fileId: file.id, valueId: value.id };
    });
  }

  /** 以健管师身份确认核对：写报告和指标，识别记录改为已核对 */
  async function verifyUpload(c: TenantContext, clientId: string, uploadId: string) {
    return withTenant(app, c, async (trx) => {
      const report = await trx
        .insertInto('health_reports')
        .values({
          ...scope(c),
          client_id: clientId,
          report_date: '2026-05-01',
          title: 'upload',
          source: 'upload',
          upload_id: uploadId,
          verified_by: c.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const indicator = await trx
        .insertInto('report_indicators')
        .values({
          ...scope(c),
          report_id: report.id,
          client_id: clientId,
          code: 'fpg',
          value: 5.1,
          unit: 'mmol/L',
          raw_name: '空腹血糖',
          original_value: '5.1',
          original_unit: 'mmol/L',
          abnormal: 'no_reference',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('report_uploads')
        .set({ status: 'verified', report_id: report.id, verified_by: c.userId, version: 2 })
        .where('id', '=', uploadId)
        .execute();
      return { reportId: report.id, indicatorId: indicator.id };
    });
  }

  let a1: Awaited<ReturnType<typeof seedUpload>>;

  beforeAll(async () => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    a1 = await seedUpload(managerA1(), f.clients.a1[0]);
    await seedUpload(managerA2(), f.clients.a2);
    await seedUpload(managerA3(), f.clients.a3);
    await seedUpload(managerB1(), f.clients.b1);
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  async function clientIdsSeenBy(c: TenantContext) {
    return withTenant(app, c, async (trx) => {
      const seen: Record<string, string[]> = {};
      for (const t of ALL_TABLES) {
        const rows = await trx.selectFrom(t).select('client_id').execute();
        seen[t] = [...new Set(rows.map((r) => r.client_id))].sort();
      }
      return seen;
    });
  }

  describe('原件清除队列（Q6）', () => {
    const storageKey = async (fileId: string) =>
      (
        await owner
          .selectFrom('report_files')
          .select('storage_key')
          .where('id', '=', fileId)
          .executeTakeFirstOrThrow()
      ).storage_key;
    const queued = async () =>
      (
        await sql<{ storage_key: string }>`select storage_key from storage_purge_queue`.execute(
          owner,
        )
      ).rows.map((r) => r.storage_key);
    const deleteClientA1 = () =>
      owner.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute();

    it('删除客户时它的原件 key 进入清除队列', async () => {
      const key = await storageKey(a1.fileId);
      expect(await queued()).toEqual([]);
      await deleteClientA1();
      expect(await queued()).toEqual([key]);
    });

    it('带租户上下文（健管师、客户、管理员）的会话不能认领或完成清除，也不能直接读队列', async () => {
      await deleteClientA1();
      for (const c of [managerA1(), managerB1(), orgAdminA(), platform()]) {
        await expect(
          withTenant(app, c, (trx) => sql`select storage_purge_claim(10)`.execute(trx)),
          c.role,
        ).rejects.toThrow(/system task/);
        await expect(
          withTenant(app, c, (trx) =>
            sql`select storage_purge_done(${['x']}::text[])`.execute(trx),
          ),
          c.role,
        ).rejects.toThrow(/system task/);
      }
      // 客户端会话（以后的客户账号）同样带 app.role / app.user_id，同样被拒绝
      await expect(
        app.transaction().execute(async (trx) => {
          await sql`select set_config('app.role', 'client', true), set_config('app.user_id', ${randomUUID()}, true)`.execute(
            trx,
          );
          await sql`select storage_purge_claim(10)`.execute(trx);
        }),
      ).rejects.toThrow(/system task/);
      await expect(sql`select storage_key from storage_purge_queue`.execute(app)).rejects.toThrow(
        /permission denied/,
      );
      expect(await queued()).toHaveLength(1);
    });

    it('认领即占用：认领过的 key 不会再被列出；只能完成认领中的 key', async () => {
      const key = await storageKey(a1.fileId);
      await deleteClientA1();
      const claim = async () =>
        (await sql<{ k: string }>`select storage_purge_claim(10) as k`.execute(app)).rows.map(
          (r) => r.k,
        );
      expect(await claim()).toEqual([key]);
      expect(await claim()).toEqual([]);
      // 没认领的 key 完成不了
      await sql`insert into storage_purge_queue (storage_key) values ('reports/unclaimed')`.execute(
        owner,
      );
      await sql`select storage_purge_done(${['reports/unclaimed']}::text[])`.execute(app);
      expect((await queued()).sort()).toEqual([key, 'reports/unclaimed'].sort());
      await sql`select storage_purge_done(${[key]}::text[])`.execute(app);
      expect(await queued()).toEqual(['reports/unclaimed']);
    });

    it('后台清除删掉对象存储里的原件并移出队列；删除失败的留到认领过期后再试', async () => {
      const key = await storageKey(a1.fileId);
      const storage = new InMemoryObjectStorage();
      await storage.put(key, Buffer.from('synthetic'), 'image/png');
      await storage.put('reports/other', Buffer.from('synthetic'), 'image/png');
      await deleteClientA1();
      const repo = new ReportsRepository(app);
      expect(await repo.purgeBatch(storage)).toBe(1);
      expect([...storage.objects.keys()]).toEqual(['reports/other']);
      expect(await queued()).toEqual([]);

      const failing = new InMemoryObjectStorage();
      failing.delete = () => Promise.reject(new Error('unavailable'));
      await deleteClientsOf(f.clients.a1[1]);
      const before = await queued();
      expect(await repo.purgeBatch(failing)).toBe(0);
      expect(await queued()).toEqual(before);
    });

    async function deleteClientsOf(clientId: string) {
      await seedUpload(managerA1(), clientId);
      await owner.deleteFrom('clients').where('id', '=', clientId).execute();
    }
  });

  it('没有租户上下文时，应用角色查不到任何一张新表或扩展表的数据', async () => {
    for (const t of [...ALL_TABLES, 'report_extraction_quota'] as const) {
      const rows = await app.selectFrom(t).selectAll().execute();
      expect(rows, t).toHaveLength(0);
    }
    // 待清除的存储 key 只有系统函数能读写
    await expect(sql`select * from storage_purge_queue`.execute(app)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('逐表：健管师只看到自己客户的数据；其他健管师、运营商、平台看不到；机构管理员只看到报告和指标', async () => {
    await verifyUpload(managerA1(), f.clients.a1[0], a1.uploadId);
    const mine = await clientIdsSeenBy(managerA1());
    for (const t of ALL_TABLES) expect(mine[t], t).toEqual([f.clients.a1[0]]);

    for (const [name, c, own] of [
      ['A2', managerA2(), f.clients.a2],
      ['A3', managerA3(), f.clients.a3],
      ['B1', managerB1(), f.clients.b1],
    ] as const) {
      const seen = await clientIdsSeenBy(c);
      for (const t of UPLOAD_TABLES) expect(seen[t], `${name} ${t}`).toEqual([own]);
    }
    for (const c of [operatorAdminA(), platform()]) {
      const seen = await clientIdsSeenBy(c);
      for (const t of ALL_TABLES) expect(seen[t], `${c.role} ${t}`).toEqual([]);
    }
    // Q14：机构管理员能读本机构的报告和指标，读不到识别记录、原件、识别结果和操作记录
    const admin = await clientIdsSeenBy(orgAdminA());
    for (const t of UPLOAD_TABLES) expect(admin[t], t).toEqual([]);
    expect(admin.health_reports).toContain(f.clients.a1[0]);
    expect(admin.report_indicators).toContain(f.clients.a1[0]);
    expect(admin.health_reports).not.toContain(f.clients.a3);
  });

  it('不能给别人的客户建识别记录，也不能冒用别人的名义', async () => {
    for (const clientId of [f.clients.a2, f.clients.b1, f.clients.a3]) {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('report_uploads')
            .values({
              ...scope(managerA1()),
              client_id: clientId,
              page_count: 1,
              uploaded_by: f.users.managerA1.id,
              requested_by: f.users.managerA1.id,
            })
            .execute(),
        ),
        clientId,
      ).rejects.toThrow();
    }
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_uploads')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            page_count: 1,
            uploaded_by: f.users.managerA2.id,
            requested_by: f.users.managerA2.id,
          })
          .execute(),
      ),
    ).rejects.toThrow(/current user/);
    // 一开始就是“已核对”也不行
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_uploads')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            page_count: 1,
            uploaded_by: f.users.managerA1.id,
            requested_by: f.users.managerA1.id,
            status: 'needs_review',
          })
          .execute(),
      ),
    ).rejects.toThrow(/queued/);
  });

  it('别人的识别记录、原件、识别结果改不了也删不了（看不到就影响 0 行）', async () => {
    const b1 = await withTenant(app, managerB1(), (trx) =>
      trx.selectFrom('report_uploads').select('id').executeTakeFirstOrThrow(),
    );
    const results = await asA1(async (trx) => [
      await trx
        .updateTable('report_uploads')
        .set({ status: 'discarded' })
        .where('id', '=', b1.id)
        .executeTakeFirst(),
      await trx
        .updateTable('extracted_values')
        .set({ raw_value: '9' })
        .where('upload_id', '=', b1.id)
        .executeTakeFirst(),
    ]);
    for (const r of results) {
      expect(r.numUpdatedRows).toBe(0n);
    }
    // 原件和识别记录本人也删不了（没有删除权限）
    await expect(
      asA1((trx) => trx.deleteFrom('report_files').where('id', '=', a1.fileId).execute()),
    ).rejects.toThrow();
    await expect(
      asA1((trx) => trx.deleteFrom('report_uploads').where('id', '=', a1.uploadId).execute()),
    ).rejects.toThrow();
  });

  it('状态机只能前进：待核对不能回到排队中，不能跳过核对，次数只在重试时加一', async () => {
    const update = (set: Record<string, unknown>) =>
      asA1((trx) =>
        trx.updateTable('report_uploads').set(set).where('id', '=', a1.uploadId).execute(),
      );
    await expect(update({ status: 'queued' })).rejects.toThrow(/cannot go/);
    await expect(update({ status: 'processing' })).rejects.toThrow(/cannot go/);
    await expect(update({ status: 'failed', failure_category: 'error' })).rejects.toThrow(
      /cannot go/,
    );
    // 没有报告就标成已核对
    await expect(
      update({ status: 'verified', verified_by: f.users.managerA1.id, report_id: randomUUID() }),
    ).rejects.toThrow(/point to its report/);
    await expect(update({ attempts: 2 })).rejects.toThrow();
    await expect(update({ version: 0 })).rejects.toThrow(/immutable/);
  });

  it('已核对、已放弃的识别记录和识别结果只读；操作记录只能追加', async () => {
    await verifyUpload(managerA1(), f.clients.a1[0], a1.uploadId);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_uploads')
          .set({ status: 'discarded' })
          .where('id', '=', a1.uploadId)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_uploads')
          .set({ institution: '改过' })
          .where('id', '=', a1.uploadId)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('extracted_values')
          .set({ raw_value: '9.9' })
          .where('id', '=', a1.valueId)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      asA1((trx) => trx.deleteFrom('extracted_values').where('id', '=', a1.valueId).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_events')
          .set({ action: 'verified' })
          .where('upload_id', '=', a1.uploadId)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) => trx.deleteFrom('report_events').where('upload_id', '=', a1.uploadId).execute()),
    ).rejects.toThrow();
    // 不能以别人的名义或系统名义记录
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_events')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            upload_id: a1.uploadId,
            actor_id: f.users.managerA2.id,
            action: 'file_viewed',
          })
          .execute(),
      ),
    ).rejects.toThrow(/current user/);
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_events')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            upload_id: a1.uploadId,
            actor_id: f.users.managerA1.id,
            action: 'transferred',
          })
          .execute(),
      ),
    ).rejects.toThrow(/current user/);
  });

  it('原件只能在上传的同一个事务里写入', async () => {
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_files')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            upload_id: a1.uploadId,
            seq: 1,
            storage_key: `reports/${randomBytes(16).toString('hex')}`,
            mime_type: 'image/png',
            size_bytes: 100,
            page_count: 1,
            sha256: randomBytes(32).toString('hex'),
            original_name: 'late.png',
          })
          .execute(),
      ),
    ).rejects.toThrow(/while uploading/);
    // 存储 key 只能是随机 id
    await expect(
      withTenant(app, managerA1(), async (trx) => {
        const u = await trx
          .insertInto('report_uploads')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[1],
            page_count: 1,
            uploaded_by: f.users.managerA1.id,
            requested_by: f.users.managerA1.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('report_files')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[1],
            upload_id: u.id,
            seq: 0,
            storage_key: 'reports/测试客户-体检.png',
            mime_type: 'image/png',
            size_bytes: 100,
            page_count: 1,
            sha256: randomBytes(32).toString('hex'),
            original_name: 'x.png',
          })
          .execute();
      }),
    ).rejects.toThrow(/storage_key/);
  });

  it('已核对的报告和指标：不能直接修改或删除；更正只能插入新行并让旧行指向它', async () => {
    const { reportId, indicatorId } = await verifyUpload(managerA1(), f.clients.a1[0], a1.uploadId);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('health_reports')
          .set({ institution: '改过' })
          .where('id', '=', reportId)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) => trx.deleteFrom('health_reports').where('id', '=', reportId).execute()),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_indicators')
          .set({ value: 9.9 })
          .where('id', '=', indicatorId)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) => trx.deleteFrom('report_indicators').where('id', '=', indicatorId).execute()),
    ).rejects.toThrow(/cannot be deleted/);

    // 合法的更正：插入新行，旧行指向新行，两行都在
    await asA1(async (trx) => {
      const id = randomUUID();
      await trx
        .updateTable('report_indicators')
        .set({ superseded_by: id })
        .where('id', '=', indicatorId)
        .execute();
      await trx
        .insertInto('report_indicators')
        .values({
          id,
          ...scope(managerA1()),
          report_id: reportId,
          client_id: f.clients.a1[0],
          code: 'fpg',
          value: 5.2,
          unit: 'mmol/L',
          raw_name: '空腹血糖',
          original_value: '5.2',
          original_unit: 'mmol/L',
          abnormal: 'no_reference',
        })
        .execute();
    });
    const rows = await owner
      .selectFrom('report_indicators')
      .select(['value', 'superseded_by'])
      .where('report_id', '=', reportId)
      .orderBy('created_at')
      .execute();
    expect(rows.map((r) => [Number(r.value), r.superseded_by === null])).toEqual([
      [5.1, false],
      [5.2, true],
    ]);
    // 被更正掉的旧行不能再改
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_indicators')
          .set({ superseded_by: null })
          .where('id', '=', indicatorId)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    // 指向不存在的行：提交时被拒绝
    const fresh = await owner
      .selectFrom('report_indicators')
      .select('id')
      .where('report_id', '=', reportId)
      .where('superseded_by', 'is', null)
      .executeTakeFirstOrThrow();
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_indicators')
          .set({ superseded_by: randomUUID() })
          .where('id', '=', fresh.id)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('上传来源的报告只能在核对时由本人写入', async () => {
    await expect(
      asA1((trx) =>
        trx
          .insertInto('health_reports')
          .values({
            ...scope(managerA1()),
            client_id: f.clients.a1[0],
            report_date: '2026-05-01',
            title: 'upload',
            source: 'upload',
            upload_id: a1.uploadId,
            verified_by: f.users.managerA2.id,
          })
          .execute(),
      ),
    ).rejects.toThrow(/under review/);
  });

  it('客户转出（Q23）：未核对的作废并清掉识别结果，原件跟着客户走；健管师调机构时 org_id 跟着变', async () => {
    // 已放弃的识别结果同样作废（Q23：未核对的结果不跟着转）
    const discarded = await seedUpload(managerA1(), f.clients.a1[0]);
    await asA1((trx) =>
      trx
        .updateTable('report_uploads')
        .set({ status: 'discarded' })
        .where('id', '=', discarded.uploadId)
        .execute(),
    );
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const seenA1 = await clientIdsSeenBy(managerA1());
    for (const t of ALL_TABLES) expect(seenA1[t], t).toEqual([]);
    const upload = await owner
      .selectFrom('report_uploads')
      .select(['status', 'failure_category', 'attempts', 'manager_id', 'requested_by'])
      .where('id', '=', a1.uploadId)
      .executeTakeFirstOrThrow();
    expect(upload).toEqual({
      status: 'failed',
      failure_category: 'transferred',
      attempts: 0,
      manager_id: f.users.managerA2.id,
      requested_by: f.users.managerA2.id,
    });
    expect(
      await owner
        .selectFrom('extracted_values')
        .select('id')
        .where('upload_id', '=', a1.uploadId)
        .execute(),
    ).toEqual([]);
    expect(
      await owner
        .selectFrom('extracted_values')
        .select('id')
        .where('upload_id', '=', discarded.uploadId)
        .execute(),
    ).toEqual([]);
    const discardedRow = await owner
      .selectFrom('report_uploads')
      .select('status')
      .where('id', '=', discarded.uploadId)
      .executeTakeFirstOrThrow();
    expect(discardedRow.status).toBe('discarded');
    const files = await withTenant(app, managerA2(), (trx) =>
      trx.selectFrom('report_files').select('id').where('upload_id', '=', a1.uploadId).execute(),
    );
    expect(files).toEqual([{ id: a1.fileId }]);

    await owner
      .updateTable('users')
      .set({ org_id: f.orgA2 })
      .where('id', '=', f.users.managerA2.id)
      .execute();
    for (const t of UPLOAD_TABLES) {
      const rows = await owner
        .selectFrom(t)
        .select('org_id')
        .where('manager_id', '=', f.users.managerA2.id)
        .execute();
      expect(rows.length, t).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.org_id)), t).toEqual(new Set([f.orgA2]));
    }
  });

  it('识别发起人查询只返回身份，只对排队中、识别中的记录有结果', async () => {
    const requester = (id: string) =>
      sql<{ user_id: string }>`select * from report_upload_requester(${id})`.execute(app);
    // 待核对：没有结果
    expect((await requester(a1.uploadId)).rows).toEqual([]);
    const queued = await withTenant(app, managerA1(), (trx) =>
      trx
        .insertInto('report_uploads')
        .values({
          ...scope(managerA1()),
          client_id: f.clients.a1[1],
          page_count: 1,
          uploaded_by: f.users.managerA1.id,
          requested_by: f.users.managerA1.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    expect((await requester(queued.id)).rows).toEqual([
      { user_id: f.users.managerA1.id, role: 'manager', operator_id: f.operatorA, org_id: f.orgA },
    ]);
    expect((await requester(randomUUID())).rows).toEqual([]);
    // 发起人不是这位客户的健管师（或不是健管师）时没有结果
    await sql`alter table report_uploads disable trigger report_uploads_guard`.execute(owner);
    try {
      for (const other of [f.users.managerA2.id, f.users.orgAdminA.id]) {
        await owner
          .updateTable('report_uploads')
          .set({ requested_by: other })
          .where('id', '=', queued.id)
          .execute();
        expect((await requester(queued.id)).rows, other).toEqual([]);
      }
    } finally {
      await sql`alter table report_uploads enable trigger report_uploads_guard`.execute(owner);
    }
  });

  it('认领只能认领当前这次识别并进入识别中；退还记录应用改不了', async () => {
    const queued = await asA1((trx) =>
      trx
        .insertInto('report_uploads')
        .values({
          ...scope(managerA1()),
          client_id: f.clients.a1[1],
          page_count: 1,
          uploaded_by: f.users.managerA1.id,
          requested_by: f.users.managerA1.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const set = (values: { status?: 'processing'; claimed_attempt?: number }) =>
      asA1((trx) =>
        trx.updateTable('report_uploads').set(values).where('id', '=', queued.id).execute(),
      );
    await expect(set({ status: 'processing', claimed_attempt: 2 })).rejects.toThrow(/claim/);
    await expect(set({ claimed_attempt: 1 })).rejects.toThrow(/claim/);
    await set({ status: 'processing', claimed_attempt: 1 });
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_uploads')
          .set({ quota_refunded_attempt: 1 } as never)
          .where('id', '=', queued.id)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('每天识别页数：只能看到和写自己的，不能超过 200 页', async () => {
    await withTenant(app, managerB1(), (trx) =>
      trx
        .insertInto('report_extraction_quota')
        .values({
          manager_id: f.users.managerB1.id,
          operator_id: f.operatorB,
          day: sql`current_date`,
          pages: 10,
        })
        .execute(),
    );
    expect(
      await asA1((trx) => trx.selectFrom('report_extraction_quota').selectAll().execute()),
    ).toEqual([]);
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_extraction_quota')
          .values({
            manager_id: f.users.managerB1.id,
            operator_id: f.operatorB,
            day: sql`current_date`,
            pages: 1,
          })
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) =>
        trx
          .insertInto('report_extraction_quota')
          .values({
            manager_id: f.users.managerA1.id,
            operator_id: f.operatorA,
            day: sql`current_date`,
            pages: 201,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('每天识别页数只能增加；只有入队失败、还没认领的那次识别能退还，且只退一次', async () => {
    const pages = async () =>
      (
        await owner
          .selectFrom('report_extraction_quota')
          .select('pages')
          .where('manager_id', '=', f.users.managerA1.id)
          .executeTakeFirst()
      )?.pages;
    await asA1((trx) =>
      trx
        .insertInto('report_extraction_quota')
        .values({
          manager_id: f.users.managerA1.id,
          operator_id: f.operatorA,
          day: sql`current_date`,
          pages: 5,
        })
        .execute(),
    );
    await expect(
      asA1((trx) =>
        trx
          .updateTable('report_extraction_quota')
          .set({ pages: 1 })
          .where('manager_id', '=', f.users.managerA1.id)
          .execute(),
      ),
    ).rejects.toThrow(/only increase/);

    const newUpload = (clientId: string) =>
      asA1((trx) =>
        trx
          .insertInto('report_uploads')
          .values({
            ...scope(managerA1()),
            client_id: clientId,
            page_count: 2,
            uploaded_by: f.users.managerA1.id,
            requested_by: f.users.managerA1.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
    const fail = (id: string, claim: boolean) =>
      asA1(async (trx) => {
        if (claim) {
          await trx
            .updateTable('report_uploads')
            .set({ status: 'processing', claimed_attempt: 1 })
            .where('id', '=', id)
            .execute();
        }
        await trx
          .updateTable('report_uploads')
          .set({ status: 'failed', failure_category: 'error' })
          .where('id', '=', id)
          .execute();
      });
    const refund = (c: TenantContext, id: string) =>
      withTenant(app, c, async (trx) => {
        const { rows } = await sql<{
          ok: boolean;
        }>`select report_quota_refund(${id}) as ok`.execute(trx);
        return rows[0]?.ok;
      });

    const unclaimed = await newUpload(f.clients.a1[1]);
    const claimed = await newUpload(f.clients.a1[1]);
    // 还在排队中：不退
    expect(await refund(managerA1(), unclaimed.id)).toBe(false);
    await fail(unclaimed.id, false);
    await fail(claimed.id, true);
    // 别人、没有租户上下文：不退；已经开始识别的：不退
    expect(await refund(managerA2(), unclaimed.id)).toBe(false);
    expect(
      (await sql<{ ok: boolean }>`select report_quota_refund(${unclaimed.id}) as ok`.execute(app))
        .rows[0]?.ok,
    ).toBe(false);
    expect(await refund(managerA1(), claimed.id)).toBe(false);
    expect(await pages()).toBe(5);
    expect(await refund(managerA1(), unclaimed.id)).toBe(true);
    expect(await pages()).toBe(3);
    expect(await refund(managerA1(), unclaimed.id)).toBe(false);
    expect(await pages()).toBe(3);
  });
});
