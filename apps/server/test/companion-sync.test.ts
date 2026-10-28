import { randomBytes } from 'node:crypto';
import { COMPANION_DELIVERY_KINDS } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withDevice, type Db } from '../src/db/database.js';
import { COMPANION_DELIVERY_KINDS_0025 } from '../src/db/migrations/0025-companion-deliveries.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { CLEAN_CLIENT_TEXT, insertTask } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M6 第 2 步：已审核产物同步给伴侣（规格 2.8、6.2、N12，红线 3；验收标准 24）。
 * 只有方案和报告解读、已审核、客户已绑定设备且没有撤回同意时才能同步；后端和数据库函数双重校验。
 * 全部是合成数据。
 */
describe('同步给伴侣', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let appDb: Db;
  let f: Fixtures;
  let a1: Agent;
  let deviceId: string;

  const scopeA1 = () => ({
    operatorId: f.operatorA,
    orgId: f.orgA,
    managerId: f.users.managerA1.id,
  });

  /** A1 第一位客户的产物；kind 默认报告解读，status 默认已审核 */
  async function artifact(
    kind = 'report_interpretation',
    status: 'draft' | 'approved' = 'approved',
    clientId = f.clients.a1[0],
  ) {
    const taskId = await insertTask(owner, scopeA1(), clientId);
    const id = crypto.randomUUID();
    const s = scopeA1();
    await owner
      .insertInto('artifacts')
      .values({
        id,
        operator_id: s.operatorId,
        org_id: s.orgId,
        manager_id: s.managerId,
        task_id: taskId,
        client_id: clientId,
        skill_id:
          kind === 'care_plan'
            ? 'care-plan'
            : kind === 'recent_summary'
              ? 'client-recent-summary'
              : 'report-interpretation',
        kind,
        lineage_id: id,
        version: 1,
        status: 'draft',
        content: JSON.stringify({ professional: '合成专业版。', clientFacing: CLEAN_CLIENT_TEXT }),
        critical_flags: JSON.stringify([]),
        ...(kind === 'care_plan'
          ? { plan_options: JSON.stringify({ sections: ['diet', 'exercise'], cycleWeeks: 8 }) }
          : {}),
      })
      .execute();
    if (status === 'approved') {
      await owner.updateTable('artifacts').set({ status }).where('id', '=', id).execute();
    }
    return id;
  }

  const sync = (agent: Agent, id: string) => agent.post(`/api/artifacts/${id}/sync-to-companion`);
  const deliveries = () => owner.selectFrom('companion_deliveries').selectAll().execute();

  beforeAll(async () => {
    app = await createTestApp();
    appDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await owner.destroy();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
    a1 = await loginAs(app, f.users.managerA1.email);
    // 告知书、同意和一台已绑定的设备（以所有者身份写入）
    await owner
      .insertInto('companion_scripts')
      .values({ kind: 'notice', version: 1, text: '测试用告知书' })
      .execute();
    const batch = await owner
      .insertInto('companion_device_batches')
      .values({ name: '测试批次', device_count: 1, imported_by: f.users.platform.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    deviceId = (
      await owner
        .insertInto('companion_devices')
        .values({
          serial_no: 'HB-SYNC-0001',
          secret_hash: randomBytes(32),
          activation_code_hash: 'x'.repeat(32),
          batch_id: batch.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
    await a1
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents`)
      .send({ noticeVersion: 1, consentedOn: '2026-10-01', confirmed: true })
      .expect(200);
    await owner
      .updateTable('companion_devices')
      .set({
        status: 'bound',
        client_id: f.clients.a1[0],
        manager_id: f.users.managerA1.id,
        operator_id: f.operatorA,
        org_id: f.orgA,
        bound_by: f.users.managerA1.id,
        bound_at: new Date(),
      } as never)
      .where('id', '=', deviceId)
      .execute();
  });

  it('迁移快照和 packages/shared 一致', () => {
    expect(COMPANION_DELIVERY_KINDS_0025).toEqual(COMPANION_DELIVERY_KINDS);
  });

  it('已审核的报告解读：同步后保存快照、记一条记录；再点一次不重复；详情显示同步时间', async () => {
    const id = await artifact();
    const before = await a1.get(`/api/artifacts/${id}`).expect(200);
    expect(before.body.companion).toEqual({ available: true, syncedAt: null });
    const res = await sync(a1, id).expect(200);
    expect(res.body.companion).toEqual({ available: true, syncedAt: expect.any(String) });
    expect(res.body.events.map((e: { action: string }) => e.action)).toContain('companion_synced');
    await sync(a1, id).expect(200);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      artifact_id: id,
      client_id: f.clients.a1[0],
      kind: 'report_interpretation',
      content: CLEAN_CLIENT_TEXT,
      manager_id: f.users.managerA1.id,
    });
  });

  it('方案也能同步；未审核、不是方案或解读、没有设备、撤回同意后都 409', async () => {
    await sync(a1, await artifact('care_plan')).expect(200);
    await sync(a1, await artifact('report_interpretation', 'draft'))
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['not_approved']));
    await sync(a1, await artifact('recent_summary'))
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['wrong_kind']));
    const otherClient = await artifact('report_interpretation', 'approved', f.clients.a1[1]);
    const detail = await a1.get(`/api/artifacts/${otherClient}`).expect(200);
    expect(detail.body.companion).toEqual({ available: false, syncedAt: null });
    await sync(a1, otherClient)
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['no_companion']));
    await a1
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents/revoke`)
      .send({ revokedOn: '2026-10-02' })
      .expect(200);
    await sync(a1, await artifact())
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['no_companion']));
    expect(await deliveries()).toHaveLength(1);
  });

  it('跨租户：别人的产物一律 404，不写入；后台角色 404', async () => {
    const id = await artifact();
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
      f.users.platform.email,
    ]) {
      await sync(await loginAs(app, email), id).expect(404);
    }
    expect(await deliveries()).toEqual([]);
  });

  it('数据库层：应用角色不能直接写快照；函数拒绝和产物不一致的内容、别人的产物', async () => {
    const id = await artifact();
    const asManager = (userId: string, operatorId: string, orgId: string) => ({
      userId,
      role: 'manager' as const,
      operatorId,
      orgId,
    });
    const { withTenant } = await import('../src/db/database.js');
    await expect(
      withTenant(appDb, asManager(f.users.managerA1.id, f.operatorA, f.orgA), (trx) =>
        trx
          .insertInto('companion_deliveries')
          .values({
            operator_id: f.operatorA,
            org_id: f.orgA,
            manager_id: f.users.managerA1.id,
            client_id: f.clients.a1[0],
            artifact_id: id,
            kind: 'report_interpretation',
            content: '篡改的内容',
            sent_by: f.users.managerA1.id,
          })
          .execute(),
      ),
    ).rejects.toThrow();
    const call = (userId: string, operatorId: string, orgId: string, content: string) =>
      withTenant(appDb, asManager(userId, operatorId, orgId), async (trx) => {
        const { rows } = await sql<{ r: string }>`
          select sync_artifact_to_companion(${id}::uuid, ${content}) as r
        `.execute(trx);
        return rows[0]?.r;
      });
    expect(await call(f.users.managerA1.id, f.operatorA, f.orgA, '篡改的内容')).toBe(
      'content_mismatch',
    );
    expect(await call(f.users.managerA2.id, f.operatorA, f.orgA, CLEAN_CLIENT_TEXT)).toBe(
      'not_found',
    );
    expect(await call(f.users.managerB1.id, f.operatorB, f.orgB, CLEAN_CLIENT_TEXT)).toBe(
      'not_found',
    );
    expect(await deliveries()).toEqual([]);
  });

  it('设备只读到自己客户的快照；别的健管师读不到', async () => {
    await sync(a1, await artifact()).expect(200);
    const seen = await withDevice(appDb, { deviceId }, (trx) =>
      trx.selectFrom('companion_deliveries').select('client_id').execute(),
    );
    expect(seen).toEqual([{ client_id: f.clients.a1[0] }]);
    // 设备解绑后读不到
    await a1.delete(`/api/clients/${f.clients.a1[0]}/companion/device`).expect(200);
    expect(
      await withDevice(appDb, { deviceId }, (trx) =>
        trx.selectFrom('companion_deliveries').select('id').execute(),
      ),
    ).toEqual([]);
    const { withTenant } = await import('../src/db/database.js');
    expect(
      await withTenant(
        appDb,
        { userId: f.users.managerA2.id, role: 'manager', operatorId: f.operatorA, orgId: f.orgA },
        (trx) => trx.selectFrom('companion_deliveries').select('id').execute(),
      ),
    ).toEqual([]);
  });
});
