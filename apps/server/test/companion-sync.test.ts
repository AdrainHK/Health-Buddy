import { randomBytes, randomUUID } from 'node:crypto';
import { COMPANION_DELIVERY_KINDS } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashActivationCode } from '../src/companion/device-credentials.js';
import { withDevice, withTenant, type Db, type TenantContext } from '../src/db/database.js';
import { COMPANION_DELIVERY_KINDS_0025 } from '../src/db/migrations/0025-companion-deliveries.js';
import type { Database } from '../src/db/types.js';
import { localDate } from '../src/twin/time-zone.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { CLEAN_CLIENT_TEXT, insertTask } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 同意和撤回日期：不能早于告知书发布日期（测试里告知书都是今天发布的） */
const TODAY = localDate(new Date(), 'Asia/Shanghai');
const CODE = 'ABCD1234';

/**
 * M6 第 2 步：已审核产物同步给伴侣（规格 2.8、6.2、N12，红线 3；验收标准 17、21、22、24）。
 * 只有方案和报告解读、已审核且是最新版本、方案是当前生效的、客户有有效同意且已绑定设备时才能同步；
 * 后端和数据库函数双重校验。设备只读在用的快照，暂停、撤回同意、解绑后读不到。全部是合成数据。
 */
describe('同步给伴侣', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let appDb: Db;
  let f: Fixtures;
  let a1: Agent;
  let codeHash: string;
  /** A1 第一位客户的设备 */
  let deviceId: string;

  const ctx = (
    userId: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId, role, operatorId, orgId });

  async function newDevice(serial: string) {
    const batch = await owner
      .insertInto('companion_device_batches')
      .values({ name: `批次 ${serial}`, device_count: 1, imported_by: f.users.platform.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    return (
      await owner
        .insertInto('companion_devices')
        .values({
          serial_no: serial,
          secret_hash: randomBytes(32),
          activation_code_hash: codeHash,
          batch_id: batch.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
  }

  /** 经接口记录同意并绑定设备 */
  async function connect(agent: Agent, clientId: string, serial: string) {
    const base = `/api/clients/${clientId}/companion`;
    await agent
      .post(`${base}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await agent.post(`${base}/device`).send({ serialNo: serial, activationCode: CODE }).expect(200);
  }

  /** A1 某位客户的产物；kind 默认报告解读，status 默认已审核 */
  async function artifact(
    kind = 'report_interpretation',
    status: 'draft' | 'approved' = 'approved',
    clientId = f.clients.a1[0],
    lineage?: { id: string; version: number },
  ) {
    // 新版本和上一版在同一个任务里
    const taskId = lineage
      ? ((
          await owner
            .selectFrom('artifacts')
            .select('task_id')
            .where('id', '=', lineage.id)
            .executeTakeFirstOrThrow()
        ).task_id as string)
      : await insertTask(
          owner,
          { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id },
          clientId,
        );
    const id = randomUUID();
    await owner
      .insertInto('artifacts')
      .values({
        id,
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
        task_id: taskId,
        client_id: clientId,
        skill_id:
          kind === 'care_plan'
            ? 'care-plan'
            : kind === 'recent_summary'
              ? 'client-recent-summary'
              : 'report-interpretation',
        kind,
        lineage_id: lineage?.id ?? id,
        version: lineage?.version ?? 1,
        ...(lineage ? { parent_id: lineage.id } : {}),
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

  /** 方案产物对应的生效方案（以所有者身份写入，相当于确认方案） */
  async function activePlan(artifactId: string, clientId = f.clients.a1[0]) {
    await owner
      .insertInto('care_plans')
      .values({
        client_id: clientId,
        artifact_id: artifactId,
        lineage_id: randomUUID(),
        sections: ['diet'],
        snapshot: JSON.stringify({ content: { professional: '合成', clientFacing: '合成' } }),
        cycle_weeks: 8,
        start_date: TODAY,
        review_date: sql`${TODAY}::date + 56`,
        status: 'active',
        approved_by: f.users.managerA1.id,
      } as never)
      .execute();
  }

  const sync = (agent: Agent, id: string) => agent.post(`/api/artifacts/${id}/sync-to-companion`);
  const withdraw = (agent: Agent, id: string) =>
    agent.delete(`/api/artifacts/${id}/sync-to-companion`);
  const deliveries = () => owner.selectFrom('companion_deliveries').selectAll().execute();
  /** 设备会话读到的快照（客户 id） */
  const deviceSees = (id: string) =>
    withDevice(appDb, { deviceId: id }, async (trx) =>
      (await trx.selectFrom('companion_deliveries').select('client_id').execute()).map(
        (r) => r.client_id,
      ),
    );

  beforeAll(async () => {
    app = await createTestApp();
    appDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
    codeHash = await hashActivationCode(CODE);
  });
  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    await owner.destroy();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
    a1 = await loginAs(app, f.users.managerA1.email);
    await owner
      .insertInto('companion_scripts')
      .values({
        kind: 'notice',
        version: 1,
        text: '测试用告知书：福宝不是医生，可以随时撤回同意。',
      })
      .execute();
    deviceId = await newDevice('HB-SYNC-0001');
    await connect(a1, f.clients.a1[0], 'HB-SYNC-0001');
  });

  it('迁移快照和 packages/shared 一致', () => {
    expect(COMPANION_DELIVERY_KINDS_0025).toEqual(COMPANION_DELIVERY_KINDS);
  });

  it('已审核的报告解读：同步后保存快照、记一条记录；再点一次不重复；可以取消同步', async () => {
    const id = await artifact();
    const before = await a1.get(`/api/artifacts/${id}`).expect(200);
    expect(before.body.companion).toEqual({ available: true, syncedAt: null, superseded: false });
    const res = await sync(a1, id).expect(200);
    expect(res.body.companion).toMatchObject({ syncedAt: expect.any(String), superseded: false });
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
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[0]]);

    const withdrawn = await withdraw(a1, id).expect(200);
    expect(withdrawn.body.companion).toMatchObject({ syncedAt: null });
    expect(withdrawn.body.events.map((e: { action: string }) => e.action)).toContain(
      'companion_withdrawn',
    );
    expect(await deviceSees(deviceId)).toEqual([]);
    await withdraw(a1, id)
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['not_synced']));
    // 取消后可以再同步
    await sync(a1, id).expect(200);
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[0]]);
  });

  it('同类内容再同步新的，旧的被替代；福宝只读在用的那份', async () => {
    const first = await artifact();
    const second = await artifact();
    await sync(a1, first).expect(200);
    await sync(a1, second).expect(200);
    const old = await a1.get(`/api/artifacts/${first}`).expect(200);
    expect(old.body.companion).toEqual({ available: true, syncedAt: null, superseded: true });
    const seen = await withDevice(appDb, { deviceId }, (trx) =>
      trx.selectFrom('companion_deliveries').select('artifact_id').execute(),
    );
    expect(seen).toEqual([{ artifact_id: second }]);
  });

  it('只同步最新的已审核版本、当前生效的方案；未审核、种类不对、没有设备、撤回同意都 409', async () => {
    const plan = await artifact('care_plan');
    await sync(a1, plan)
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['not_current_plan']));
    await activePlan(plan);
    await sync(a1, plan).expect(200);

    const v1 = await artifact();
    await artifact('report_interpretation', 'approved', f.clients.a1[0], { id: v1, version: 2 });
    await sync(a1, v1)
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['not_latest']));
    await sync(a1, await artifact('report_interpretation', 'draft'))
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['not_approved']));
    await sync(a1, await artifact('recent_summary'))
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['wrong_kind']));

    const otherClient = await artifact('report_interpretation', 'approved', f.clients.a1[1]);
    expect((await a1.get(`/api/artifacts/${otherClient}`).expect(200)).body.companion).toEqual({
      available: false,
      syncedAt: null,
      superseded: false,
    });
    await sync(a1, otherClient)
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['no_companion']));

    await a1
      .post(`/api/clients/${f.clients.a1[0]}/companion/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    await sync(a1, await artifact())
      .expect(409)
      .expect((r) => expect(r.body.reasons).toEqual(['no_companion']));
    expect(await deliveries()).toHaveLength(1);
  });

  it('跨租户：别人的产物同步、取消同步一律 404，不写入；后台角色 404', async () => {
    const id = await artifact();
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
      f.users.platform.email,
    ]) {
      const agent = await loginAs(app, email);
      await sync(agent, id).expect(404);
      await withdraw(agent, id).expect(404);
    }
    expect(await deliveries()).toEqual([]);
  });

  it('数据库层：应用角色不能直接写快照；函数拒绝和产物不一致的内容、别人的产物', async () => {
    const id = await artifact();
    const a1Ctx = ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
    await expect(
      withTenant(appDb, a1Ctx, (trx) =>
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
    const call = (c: TenantContext, content: string) =>
      withTenant(appDb, c, async (trx) => {
        const { rows } = await sql<{ r: string }>`
          select sync_artifact_to_companion(${id}::uuid, ${content}) as r
        `.execute(trx);
        return rows[0]?.r;
      });
    expect(await call(a1Ctx, '篡改的内容')).toBe('content_mismatch');
    expect(
      await call(ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA), CLEAN_CLIENT_TEXT),
    ).toBe('not_found');
    expect(
      await call(ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB), CLEAN_CLIENT_TEXT),
    ).toBe('not_found');
    expect(await deliveries()).toEqual([]);
  });

  it('设备：别的客户的设备（同健管师、同协会不同机构、不同运营商）都读不到；暂停、撤回同意后也读不到', async () => {
    await sync(a1, await artifact()).expect(200);
    const sameManager = await newDevice('HB-SYNC-0002');
    await connect(a1, f.clients.a1[1], 'HB-SYNC-0002');
    const otherOrg = await newDevice('HB-SYNC-0003');
    await connect(await loginAs(app, f.users.managerA3.email), f.clients.a3, 'HB-SYNC-0003');
    const otherOperator = await newDevice('HB-SYNC-0004');
    await connect(await loginAs(app, f.users.managerB1.email), f.clients.b1, 'HB-SYNC-0004');
    for (const d of [sameManager, otherOrg, otherOperator]) expect(await deviceSees(d)).toEqual([]);
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[0]]);

    const base = `/api/clients/${f.clients.a1[0]}/companion`;
    await a1.post(`${base}/pause`).expect(200);
    expect(await deviceSees(deviceId)).toEqual([]);
    await a1.post(`${base}/resume`).expect(200);
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[0]]);
    await a1
      .post(`${base}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    expect(await deviceSees(deviceId)).toEqual([]);

    // 机构、协会、平台会话和别的健管师都读不到
    for (const c of [
      ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA),
      ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null),
      ctx(f.users.platform.id, 'platform_admin', null, null),
      ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA),
    ]) {
      expect(
        await withTenant(appDb, c, (trx) =>
          trx.selectFrom('companion_deliveries').select('id').execute(),
        ),
      ).toEqual([]);
    }
  });

  it('解绑再绑给另一位客户：设备只读到新客户的快照（验收标准 22）', async () => {
    await sync(a1, await artifact()).expect(200);
    await a1.delete(`/api/clients/${f.clients.a1[0]}/companion/device`).expect(200);
    expect(await deviceSees(deviceId)).toEqual([]);
    await connect(a1, f.clients.a1[1], 'HB-SYNC-0001');
    expect(await deviceSees(deviceId)).toEqual([]);
    await sync(a1, await artifact('report_interpretation', 'approved', f.clients.a1[1])).expect(
      200,
    );
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[1]]);
  });

  it('客户转给别的机构的健管师：快照跟着客户走，原健管师读不到（验收标准 21）', async () => {
    await sync(a1, await artifact()).expect(200);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
      .where('id', '=', f.clients.a1[0])
      .execute();
    expect(
      await withTenant(appDb, ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA), (trx) =>
        trx.selectFrom('companion_deliveries').select('id').execute(),
      ),
    ).toEqual([]);
    const moved = await withTenant(
      appDb,
      ctx(f.users.managerA3.id, 'manager', f.operatorA, f.orgA2),
      (trx) => trx.selectFrom('companion_deliveries').select(['manager_id', 'org_id']).execute(),
    );
    expect(moved).toEqual([{ manager_id: f.users.managerA3.id, org_id: f.orgA2 }]);
    expect(await deviceSees(deviceId)).toEqual([f.clients.a1[0]]);
  });
});
