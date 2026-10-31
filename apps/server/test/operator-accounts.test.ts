import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVITE_RATE_LIMITER } from '../src/admin-accounts/admin-accounts.controller.js';
import type { LoginRateLimiter } from '../src/auth/login-rate-limiter.js';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M7 第 2 步：协会开通机构和账号（规格 2.4，验收 3、4、5、13、14、16，Q7、Q8、Q9）。
 * 协会 A 的运营商管理员只能动本协会；能看到客户明细的账号（名下有客户的健管师、有客户机构的
 * 机构管理员）不能由协会重发邀请或新开（产品负责人 2026-10-31 确认）。全部是合成数据。
 */
describe('协会开通机构和账号', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let opA: Agent;

  const as = (email: string) => loginAs(app, email);
  const anon = () => request.agent(app.getHttpServer());
  const tokenOf = (path: string) => path.replace('/#/invite/', '');
  const setSeats = (operatorId: string, n: number) =>
    owner
      .updateTable('operators')
      .set({ seat_limit: n } as never)
      .where('id', '=', operatorId)
      .execute();
  const row = (n: number, over: Record<string, string> = {}) => ({
    row: n,
    displayName: `合成健管师${n}`,
    email: `m7-batch-${n}@test.example`,
    role: 'manager',
    orgName: '',
    ...over,
  });
  const usersWithEmail = (like: string) =>
    owner.selectFrom('users').select('id').where('email', 'like', like).execute();

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    app.get<LoginRateLimiter>(INVITE_RATE_LIMITER).clear();
    f = await seedFixtures(owner);
    // 协会 A 现有 3 位占席位的健管师（A1、A2、A3 已激活，停用的不算）
    await setSeats(f.operatorA, 20);
    opA = await as(f.users.operatorAdminA.email);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('验收 3：开机构、单个开通一位、批量导入 5 位；6 位都能设置密码并登录', async () => {
    const org = (
      await opA.post('/api/admin/organizations').send({ name: '合成机构 M7' }).expect(201)
    ).body.organization as { id: string; name: string };
    expect(org).toMatchObject({ name: '合成机构 M7', managerCount: 0, clientCount: 0 });
    // 同一协会机构重名 409
    await opA.post('/api/admin/organizations').send({ name: ' 合成机构 m7 ' }).expect(409);

    const single = await opA
      .post('/api/admin/accounts')
      .send({
        displayName: '合成单个',
        email: 'm7-single@test.example',
        role: 'manager',
        orgId: org.id,
      })
      .expect(201);
    expect(single.headers['cache-control']).toBe('no-store');
    expect(single.body.account).toMatchObject({
      role: 'manager',
      status: 'pending',
      orgId: org.id,
    });

    const batch = await opA
      .post('/api/admin/accounts/import')
      .send({
        rows: [
          row(2, { orgName: '合成机构 M7' }),
          row(3),
          row(4),
          row(5),
          row(6, { role: 'org_admin', orgName: '合成机构 m7' }),
        ],
      })
      .expect(201);
    expect(batch.headers['cache-control']).toBe('no-store');
    const invites = batch.body.invites as {
      row: number;
      account: { role: string; orgId: string | null };
      invitePath: string;
    }[];
    expect(invites.map((i) => i.row)).toEqual([2, 3, 4, 5, 6]);
    expect(invites[0]!.account.orgId).toBe(org.id);
    expect(invites[4]!.account).toMatchObject({ role: 'org_admin', orgId: org.id });

    for (const [i, path] of [
      single.body.invitePath,
      ...invites.map((x) => x.invitePath),
    ].entries()) {
      const res = await anon()
        .post('/api/auth/invite/accept')
        .send({ token: tokenOf(path), password: `synthetic-pass-${i}00` })
        .expect(200);
      expect(['manager', 'org_admin']).toContain(res.body.role);
    }
    await anon()
      .post('/api/auth/login')
      .send({ email: 'm7-batch-3@test.example', password: 'synthetic-pass-200' })
      .expect(200);

    const me = (await opA.get('/api/admin/my-operator').expect(200)).body.operator;
    expect(me).toMatchObject({ id: f.operatorA, seatsUsed: 3 + 5, seatLimit: 20 });
    const orgs = (await opA.get('/api/admin/organizations').expect(200)).body.organizations as {
      id: string;
      managerCount: number;
      clientCount: number;
    }[];
    expect(orgs.find((o) => o.id === org.id)).toMatchObject({ managerCount: 2 });
    expect(orgs.find((o) => o.id === f.orgA)).toMatchObject({ clientCount: 3 });
    // 审计：机构开通、6 个邀请
    const audit = await owner
      .selectFrom('admin_audit_log')
      .select(['object_type', 'action'])
      .where('operator_id', '=', f.operatorA)
      .execute();
    expect(audit.filter((a) => a.object_type === 'organization')).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'invited')).toHaveLength(6);
  });

  it('验收 4、16：有错的行整批不导入，返回行号和原因；邮箱属于别的协会只说不可用', async () => {
    const res = await opA
      .post('/api/admin/accounts/import')
      .send({
        rows: [
          row(2),
          row(3, { email: 'm7-batch-2@test.example' }),
          row(4, { email: f.users.managerB1.email }),
          row(5, { orgName: '测试机构B' }),
          row(6, { role: 'operator_admin' }),
          row(7, { email: 'not-an-email' }),
          row(8, { role: 'org_admin' }),
          row(9, { role: 'org_admin', orgName: '测试机构A' }),
        ],
      })
      .expect(400);
    expect(res.body).toMatchObject({
      error: 'bad_request',
      rowErrors: [
        { row: 3, code: 'email_repeated' },
        { row: 4, code: 'email_taken' },
        { row: 5, code: 'org_not_found' },
        { row: 6, code: 'role_invalid' },
        { row: 7, code: 'email_invalid' },
        { row: 8, code: 'org_required' },
        { row: 9, code: 'has_clients' },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('assoc-b');
    expect(JSON.stringify(res.body)).not.toContain(f.operatorB);
    expect(await usersWithEmail('m7-batch-%')).toEqual([]);
    // 改正后重新上传成功
    await opA
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2), row(3)] })
      .expect(201);
    expect(await usersWithEmail('m7-batch-%')).toHaveLength(2);
  });

  it('验收 5：席位只剩 1 个时导入 2 行整批拒绝；单个开通也拦；机构管理员不占席位', async () => {
    await setSeats(f.operatorA, 4);
    const res = await opA
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2), row(3)] })
      .expect(409);
    expect(res.body).toEqual({ error: 'seat_limit_reached', seatsLeft: 1, needed: 2 });
    expect(await usersWithEmail('m7-batch-%')).toEqual([]);
    await opA
      .post('/api/admin/accounts')
      .send({ displayName: '合成', email: 'm7-s1@test.example', role: 'manager', orgId: null })
      .expect(201);
    expect(
      (
        await opA
          .post('/api/admin/accounts')
          .send({ displayName: '合成', email: 'm7-s2@test.example', role: 'manager', orgId: null })
          .expect(409)
      ).body.error,
    ).toBe('seat_limit_reached');
    // 机构管理员不占席位：席位满了照样能开
    const org = (await opA.post('/api/admin/organizations').send({ name: '空机构' }).expect(201))
      .body.organization as { id: string };
    await opA
      .post('/api/admin/accounts')
      .send({ displayName: '合成', email: 'm7-org@test.example', role: 'org_admin', orgId: org.id })
      .expect(201);
  });

  it('席位：两个请求并发开通最后一个席位，只成功一个', async () => {
    await setSeats(f.operatorA, 4);
    const [a, b] = await Promise.all(
      [1, 2].map((n) =>
        opA.post('/api/admin/accounts').send({
          displayName: '合成',
          email: `m7-race-${n}@test.example`,
          role: 'manager',
          orgId: null,
        }),
      ),
    );
    expect([a!.status, b!.status].sort()).toEqual([201, 409]);
    expect(await usersWithEmail('m7-race-%')).toHaveLength(1);
  });

  it('重发邀请和停用：没有客户的可以；名下有客户的 409 has_clients，密码和状态不变（Q8）', async () => {
    // 待激活的健管师可以重发
    const pending = (
      await opA
        .post('/api/admin/accounts')
        .send({ displayName: '合成', email: 'm7-p@test.example', role: 'manager', orgId: null })
        .expect(201)
    ).body.account as { id: string };
    await opA.post(`/api/admin/accounts/${pending.id}/reinvite`).expect(200);

    // 已激活、名下没有客户：先把 A2 的客户转给 A1
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA1.id } as never)
      .where('id', '=', f.clients.a2)
      .execute();
    const re = await opA.post(`/api/admin/accounts/${f.users.managerA2.id}/reinvite`).expect(200);
    expect(re.body.account.status).toBe('pending');

    const before = await owner
      .selectFrom('users')
      .select(['password_hash', 'status'])
      .where('id', '=', f.users.managerA1.id)
      .executeTakeFirstOrThrow();
    expect(
      (await opA.post(`/api/admin/accounts/${f.users.managerA1.id}/reinvite`).expect(409)).body,
    ).toEqual({ error: 'has_clients' });
    expect(
      (await opA.post(`/api/admin/accounts/${f.users.managerA1.id}/suspend`).expect(409)).body,
    ).toEqual({ error: 'has_clients' });
    // 有客户的机构的机构管理员同样不能重发；新开这个机构的机构管理员也不行
    await opA.post(`/api/admin/accounts/${f.users.orgAdminA.id}/reinvite`).expect(409);
    await opA
      .post('/api/admin/accounts')
      .send({ displayName: '合成', email: 'm7-oa@test.example', role: 'org_admin', orgId: f.orgA })
      .expect(409);
    // 平台停用有客户的健管师同样拒绝
    const platform = await as(f.users.platform.email);
    await platform.post(`/api/admin/accounts/${f.users.managerA1.id}/suspend`).expect(409);
    const after = await owner
      .selectFrom('users')
      .select(['password_hash', 'status'])
      .where('id', '=', f.users.managerA1.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);

    // 机构管理员可以停用、恢复（会话失效）；运营商管理员不能动别的运营商管理员和自己
    await opA.post(`/api/admin/accounts/${f.users.orgAdminA.id}/suspend`).expect(200);
    await opA.post(`/api/admin/accounts/${f.users.orgAdminA.id}/resume`).expect(200);
    await opA.post(`/api/admin/accounts/${f.users.operatorAdminA.id}/suspend`).expect(400);
  });

  it('租户审查 B1：剩余席位正好等于导入的健管师数时写入成功，返回全部链接', async () => {
    await setSeats(f.operatorA, 5);
    const res = await opA
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2), row(3)] })
      .expect(201);
    expect(res.body.invites).toHaveLength(2);
    expect(await usersWithEmail('m7-batch-%')).toHaveLength(2);
  });

  it('租户审查 B2：席位满时不能恢复停用的健管师；有空位后可以', async () => {
    await setSeats(f.operatorA, 3);
    expect(
      (await opA.post(`/api/admin/accounts/${f.users.disabledManagerA.id}/resume`).expect(409)).body
        .error,
    ).toBe('seat_limit_reached');
    const platform = await as(f.users.platform.email);
    await platform.post(`/api/admin/accounts/${f.users.disabledManagerA.id}/resume`).expect(409);
    await setSeats(f.operatorA, 4);
    await opA.post(`/api/admin/accounts/${f.users.disabledManagerA.id}/resume`).expect(200);
  });

  it('租户审查 B3：客户转出后仍留有服务记录的健管师不能重发邀请；只是停用可以', async () => {
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA1.id } as never)
      .where('id', '=', f.clients.a2)
      .execute();
    // A2 名下没有客户了，但留着一条和客户相关的任务（客户转出时任务归档、不删除）
    await owner
      .insertInto('tasks' as never)
      .values({
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA2.id,
        title: '合成历史任务',
        archived_at: new Date(),
        detached_reason: 'client_transferred',
      } as never)
      .execute();
    expect(
      (await opA.post(`/api/admin/accounts/${f.users.managerA2.id}/reinvite`).expect(409)).body,
    ).toEqual({ error: 'has_clients' });
    await opA.post(`/api/admin/accounts/${f.users.managerA2.id}/suspend`).expect(200);
  });

  it('Q16：平台不能代办协会开机构和账号（接口 403，数据库函数 42501）', async () => {
    const platform = await as(f.users.platform.email);
    await platform.get('/api/admin/my-operator').expect(403);
    await platform.get('/api/admin/organizations').expect(403);
    await platform.post('/api/admin/organizations').send({ name: '平台代办机构' }).expect(403);
    await platform.get('/api/admin/accounts').expect(403);
    await platform
      .post('/api/admin/accounts')
      .send({ displayName: 'x', email: 'm7-pf@test.example', role: 'manager', orgId: null })
      .expect(403);
    await platform
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2)] })
      .expect(403);
    const db = app.get<Db>(DB);
    const ctx = {
      userId: f.users.platform.id,
      role: 'platform_admin' as const,
      operatorId: null,
      orgId: null,
    };
    const exp = new Date(Date.now() + 3_600_000);
    for (const q of [
      sql`select admin_create_organization('平台代办')`,
      sql`select admin_import_accounts('[]'::jsonb, ${exp}, true)`,
      sql`select * from admin_client_counts()`,
    ]) {
      await expect(withTenant(db, ctx, (trx) => q.execute(trx))).rejects.toMatchObject({
        code: '42501',
      });
    }
    // 机构管理员的会话同样被拒绝
    const ctxOrg = {
      userId: f.users.orgAdminA.id,
      role: 'org_admin' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    for (const q of [
      sql`select admin_create_organization('机构代办')`,
      sql`select admin_import_accounts('[]'::jsonb, ${exp}, true)`,
    ]) {
      await expect(withTenant(db, ctxOrg, (trx) => q.execute(trx))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('列表：运营商管理员看本协会账号和客户数；机构管理员只看本机构、只读；健管师 403', async () => {
    const list = (await opA.get('/api/admin/accounts').expect(200)).body.accounts as {
      id: string;
      clientCount: number | null;
    }[];
    const ids = list.map((a) => a.id);
    expect(ids).toContain(f.users.managerA3.id);
    expect(ids).not.toContain(f.users.managerB1.id);
    expect(list.find((a) => a.id === f.users.managerA1.id)?.clientCount).toBe(2);
    expect(list.find((a) => a.id === f.users.orgAdminA.id)?.clientCount).toBe(3);
    expect(JSON.stringify(list)).not.toContain('测试客户');

    const orgAdmin = await as(f.users.orgAdminA.email);
    const own = (await orgAdmin.get('/api/admin/accounts').expect(200)).body.accounts as {
      id: string;
      clientCount: number | null;
    }[];
    expect(own.map((a) => a.id)).toContain(f.users.managerA1.id);
    expect(own.map((a) => a.id)).not.toContain(f.users.managerA3.id);
    expect(own.every((a) => a.clientCount === null)).toBe(true);
    await orgAdmin.get('/api/admin/organizations').expect(403);
    await orgAdmin.get('/api/admin/my-operator').expect(403);
    await orgAdmin.post('/api/admin/organizations').send({ name: 'x' }).expect(403);
    await orgAdmin
      .post('/api/admin/accounts')
      .send({ displayName: 'x', email: 'm7-x@test.example', role: 'manager', orgId: null })
      .expect(403);
    await orgAdmin
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2)] })
      .expect(403);
    await orgAdmin.post(`/api/admin/accounts/${f.users.managerA2.id}/suspend`).expect(403);

    const manager = await as(f.users.managerA1.email);
    for (const path of [
      '/api/admin/accounts',
      '/api/admin/organizations',
      '/api/admin/my-operator',
    ]) {
      await manager.get(path).expect(403);
    }
    await manager
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2)] })
      .expect(403);
    expect(await usersWithEmail('m7-%')).toEqual([]);
  });

  it('验收 13：协会 A 的管理员动协会 B 的机构和账号一律 404，B 的数据不变', async () => {
    await setSeats(f.operatorB, 20);
    // 用 B 的机构开账号
    await opA
      .post('/api/admin/accounts')
      .send({ displayName: '合成', email: 'm7-x1@test.example', role: 'manager', orgId: f.orgB })
      .expect(404);
    await opA
      .post('/api/admin/accounts')
      .send({ displayName: '合成', email: 'm7-x2@test.example', role: 'org_admin', orgId: f.orgB })
      .expect(404);
    await opA
      .post('/api/admin/accounts/import')
      .send({ rows: [row(2, { orgName: '测试机构B' }), row(3, { orgName: f.orgB })] })
      .expect(400);
    for (const action of ['suspend', 'resume', 'reinvite']) {
      await opA.post(`/api/admin/accounts/${f.users.managerB1.id}/${action}`).expect(404);
      await opA.post(`/api/admin/accounts/${f.users.operatorAdminB.id}/${action}`).expect(404);
    }
    const list = (await opA.get('/api/admin/accounts').expect(200)).body.accounts as {
      id: string;
    }[];
    expect(list.map((x) => x.id)).not.toContain(f.users.managerB1.id);
    const b = await owner
      .selectFrom('users')
      .select(['id', 'status', 'password_hash'])
      .where('operator_id', '=', f.operatorB)
      .orderBy('id')
      .execute();
    expect(b.every((u) => u.status === 'active' && u.password_hash)).toBe(true);
    expect(await usersWithEmail('m7-x%')).toEqual([]);
    const orgs = (await opA.get('/api/admin/organizations').expect(200)).body.organizations as {
      id: string;
    }[];
    expect(orgs.map((o) => o.id)).not.toContain(f.orgB);
  });

  it('数据库层：以协会 A 的会话直接调用函数带 B 的参数被拒绝；停用协会的管理员不能调用', async () => {
    const db = app.get<Db>(DB);
    const ctxA = {
      userId: f.users.operatorAdminA.id,
      role: 'operator_admin' as const,
      operatorId: f.operatorA,
      orgId: null,
    };
    const exp = new Date(Date.now() + 3_600_000);
    const hash = Buffer.alloc(32, 7);
    await expect(
      withTenant(db, ctxA, (trx) =>
        sql`select admin_invite_user('manager', ${f.operatorB}::uuid, null, 'm7-db@test.example', 'x', ${hash}, ${exp})`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P0002' });
    await expect(
      withTenant(db, ctxA, (trx) =>
        sql`select admin_invite_user('operator_admin', ${f.operatorA}::uuid, null, 'm7-db@test.example', 'x', ${hash}, ${exp})`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const r = await withTenant(db, ctxA, (trx) =>
      sql<{
        ok: boolean;
      }>`select admin_set_user_status(${f.users.managerB1.id}::uuid, true) as ok`.execute(trx),
    );
    expect(r.rows[0]?.ok).toBe(false);
    // 会话变量冒充别的协会：账号本身不属于那个协会，拒绝
    await expect(
      withTenant(db, { ...ctxA, operatorId: f.operatorB }, (trx) =>
        sql`select admin_create_organization('冒充机构')`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 健管师、机构管理员的会话调用一律拒绝
    await expect(
      withTenant(
        db,
        { userId: f.users.orgAdminA.id, role: 'org_admin', operatorId: f.operatorA, orgId: f.orgA },
        (trx) => sql`select * from admin_client_counts()`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 应用角色不能直接调内部工具函数
    await expect(
      withTenant(db, ctxA, (trx) =>
        sql`select admin_seats_left(${f.operatorA}::uuid)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 协会被停用后，它的管理员调用被拒绝
    await owner
      .updateTable('operators')
      .set({ status: 'suspended', suspended_reason: '合成停用原因' } as never)
      .where('id', '=', f.operatorA)
      .execute();
    await expect(
      withTenant(db, ctxA, (trx) => sql`select admin_create_organization('x')`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await usersWithEmail('m7-db%')).toEqual([]);
  });
});
