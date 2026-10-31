import { Logger, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_RATE_LIMITER } from '../src/admin-accounts/admin-accounts.controller.js';
import type { LoginRateLimiter } from '../src/auth/login-rate-limiter.js';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M7 第 1 步：协会和账号开通（规格 2.1、2.4、2.7，验收 1、6、7、13、15、18、19）。
 * 平台开通协会和它的运营商管理员；本人凭一次性邀请链接设置密码；停用协会、账号后立即登出；
 * 每个写操作有审计记录，审计日志只能追加。全部是合成数据。
 */
describe('协会和账号开通', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let platform: Agent;

  const as = (email: string) => loginAs(app, email);
  const anon = () => request.agent(app.getHttpServer());
  const tokenOf = (path: string) => path.replace('/#/invite/', '');
  const today = () => new Date().toISOString().slice(0, 10);
  const NEW_OPERATOR = {
    name: '合成协会 M7',
    slug: 'assoc-m7',
    region: ['44', '4403'],
    seatLimit: 10,
    contractStart: '2026-11-01',
    contractEnd: '2027-10-31',
  };

  const openOperator = async () =>
    (await platform.post('/api/admin/operators').send(NEW_OPERATOR).expect(201)).body.operator as {
      id: string;
    };
  const inviteAdmin = async (operatorId: string, email = 'm7-admin@test.example') =>
    (
      await platform
        .post(`/api/admin/operators/${operatorId}/accounts`)
        .send({ displayName: '合成管理员', email, role: 'operator_admin' })
        .expect(201)
    ).body as { account: { id: string; status: string }; invitePath: string };
  const accept = (token: string, password = 'synthetic-pass-123') =>
    anon().post('/api/auth/invite/accept').send({ token, password });

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    app.get<LoginRateLimiter>(INVITE_RATE_LIMITER).clear();
    f = await seedFixtures(owner);
    platform = await as(f.users.platform.email);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('验收 1：平台开通协会、开第一位运营商管理员；本人用邀请链接设置密码后能登录，登录前不能登录', async () => {
    const op = await openOperator();
    const list = (await platform.get('/api/admin/operators').expect(200)).body.operators as {
      id: string;
      seatLimit: number;
      seatsUsed: number;
      region: string[];
    }[];
    expect(list.find((o) => o.id === op.id)).toMatchObject({
      seatLimit: 10,
      seatsUsed: 0,
      region: ['44', '4403'],
    });
    const invite = await inviteAdmin(op.id);
    expect(invite.account.status).toBe('pending');
    expect(invite.invitePath).toMatch(/^\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    // 待激活：随便什么密码都登录不了
    await anon()
      .post('/api/auth/login')
      .send({ email: 'm7-admin@test.example', password: 'synthetic-pass-123' })
      .expect(401);
    const res = await accept(tokenOf(invite.invitePath)).expect(200);
    expect(res.body).toEqual({ role: 'operator_admin' });
    const admin = anon();
    await admin
      .post('/api/auth/login')
      .send({ email: 'm7-admin@test.example', password: 'synthetic-pass-123' })
      .expect(200);
    const me = (await admin.get('/api/auth/me').expect(200)).body.user;
    expect(me).toMatchObject({ role: 'operator_admin', operator: { id: op.id } });
  });

  it('验收 6：链接只能用一次；过期的不能用；重发邀请后旧链接失效、旧密码作废、会话登出', async () => {
    const op = await openOperator();
    const invite = await inviteAdmin(op.id);
    const token = tokenOf(invite.invitePath);
    await accept(token).expect(200);
    expect((await accept(token).expect(410)).body).toEqual({ error: 'invite_expired' });
    // 格式对但不存在的令牌同样 410，不区分原因
    await accept('A'.repeat(43)).expect(410);
    // 密码太短 400
    const second = await inviteAdmin(op.id, 'm7-admin2@test.example');
    await accept(tokenOf(second.invitePath), 'short').expect(400);
    // 过期
    await owner
      .updateTable('account_invites' as never)
      .set({ expires_at: new Date(Date.now() - 1000) } as never)
      .where('user_id' as never, '=', second.account.id as never)
      .execute();
    await accept(tokenOf(second.invitePath)).expect(410);

    // 重发：已登录的会话失效，旧密码登录不了，新链接能用
    const admin = await anon()
      .post('/api/auth/login')
      .send({ email: 'm7-admin@test.example', password: 'synthetic-pass-123' })
      .expect(200);
    const cookie = admin.headers['set-cookie']!;
    const re = await platform.post(`/api/admin/accounts/${invite.account.id}/reinvite`).expect(200);
    expect(re.body.account.status).toBe('pending');
    await anon().get('/api/auth/me').set('Cookie', cookie).expect(401);
    await anon()
      .post('/api/auth/login')
      .send({ email: 'm7-admin@test.example', password: 'synthetic-pass-123' })
      .expect(401);
    await accept(tokenOf(re.body.invitePath), 'another-pass-456').expect(200);
  });

  it('验收 7：停用协会后该协会已登录的人马上 401、不能再登录；恢复后照常。停用账号同样', async () => {
    const opAdminA = await as(f.users.operatorAdminA.email);
    const managerA1 = await as(f.users.managerA1.email);
    await opAdminA.get('/api/auth/me').expect(200);
    // 停用原因太短 400
    await platform
      .post(`/api/admin/operators/${f.operatorA}/suspend`)
      .send({ reason: '太短' })
      .expect(400);
    const s = await platform
      .post(`/api/admin/operators/${f.operatorA}/suspend`)
      .send({ reason: '合同纠纷，暂停服务' })
      .expect(200);
    expect(s.body.operator).toMatchObject({
      status: 'suspended',
      suspendedReason: '合同纠纷，暂停服务',
    });
    await opAdminA.get('/api/auth/me').expect(401);
    await managerA1.get('/api/auth/me').expect(401);
    await anon()
      .post('/api/auth/login')
      .send({ email: f.users.managerA1.email, password: 'test-password-123' })
      .expect(401);
    await platform.post(`/api/admin/operators/${f.operatorA}/resume`).expect(200);
    await as(f.users.managerA1.email);

    const m = await as(f.users.managerA1.email);
    await platform.post(`/api/admin/accounts/${f.users.managerA1.id}/suspend`).expect(200);
    await m.get('/api/auth/me').expect(401);
    const back = await platform
      .post(`/api/admin/accounts/${f.users.managerA1.id}/resume`)
      .expect(200);
    expect(back.body.account.status).toBe('active');
    await as(f.users.managerA1.email);
    // 平台不能停用自己
    await platform.post(`/api/admin/accounts/${f.users.platform.id}/suspend`).expect(400);
  });

  it('租户审查 B1：平台不能给健管师、机构管理员重发邀请（拿到链接就能冒充看客户明细）；健管师的密码不变', async () => {
    for (const u of [f.users.managerA1, f.users.orgAdminA]) {
      await platform.post(`/api/admin/accounts/${u.id}/reinvite`).expect(404);
      await as(u.email);
    }
    // 别的平台管理员也不行
    await platform.post(`/api/admin/accounts/${f.users.platform.id}/reinvite`).expect(404);
  });

  it('租户审查 S1、S4：停用待激活账号后旧链接作废，恢复后也不能用；协会停用时不能激活', async () => {
    const op = await openOperator();
    const invite = await inviteAdmin(op.id);
    await platform.post(`/api/admin/accounts/${invite.account.id}/suspend`).expect(200);
    const back = await platform.post(`/api/admin/accounts/${invite.account.id}/resume`).expect(200);
    expect(back.body.account.status).toBe('pending');
    await accept(tokenOf(invite.invitePath)).expect(410);
    const re = await platform.post(`/api/admin/accounts/${invite.account.id}/reinvite`).expect(200);
    expect(re.headers['cache-control']).toBe('no-store');
    await platform
      .post(`/api/admin/operators/${op.id}/suspend`)
      .send({ reason: '暂停测试协会' })
      .expect(200);
    await accept(tokenOf(re.body.invitePath)).expect(410);
    await platform.post(`/api/admin/operators/${op.id}/resume`).expect(200);
    await accept(tokenOf(re.body.invitePath)).expect(200);
    // 已停用的账号不能重发邀请
    await platform.post(`/api/admin/accounts/${invite.account.id}/suspend`).expect(200);
    await platform.post(`/api/admin/accounts/${invite.account.id}/reinvite`).expect(400);
  });

  it('接受邀请失败太多次 429（按 IP 计数）', async () => {
    for (let i = 0; i < 5; i++) await accept('C'.repeat(43)).expect(410);
    await accept('C'.repeat(43)).expect(429);
  });

  it('验收 19：每个写操作有一条审计记录，邮箱是掩码、没有令牌；能按时间导出 CSV；运营商只看本协会', async () => {
    const op = await openOperator();
    await platform
      .patch(`/api/admin/operators/${op.id}`)
      .send({ ...NEW_OPERATOR, seatLimit: 20 })
      .expect(400);
    const editable = { ...NEW_OPERATOR, slug: undefined };
    await platform
      .patch(`/api/admin/operators/${op.id}`)
      .send({ ...editable, seatLimit: 20 })
      .expect(200);
    const invite = await inviteAdmin(op.id);
    await accept(tokenOf(invite.invitePath)).expect(200);
    const log = (
      await platform
        .get(`/api/admin/audit-log?from=${today()}&to=${today()}&operatorId=${op.id}`)
        .expect(200)
    ).body.entries as { action: string; before: unknown; after: unknown }[];
    expect(log.map((e) => e.action).sort()).toEqual(['activated', 'created', 'invited', 'updated']);
    const text = JSON.stringify(log);
    expect(text).toContain('m***@test.example');
    expect(text).not.toContain('m7-admin@test.example');
    expect(text).not.toContain(tokenOf(invite.invitePath));
    expect(log.find((e) => e.action === 'updated')).toMatchObject({
      before: { seat_limit: 10 },
      after: { seat_limit: 20 },
    });
    const csv = await platform
      .get(`/api/admin/audit-log/export?from=${today()}&to=${today()}&operatorId=${op.id}`)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n').filter(Boolean)).toHaveLength(5);

    // 运营商管理员 A 只看到协会 A 的记录
    await platform
      .post(`/api/admin/operators/${f.operatorA}/suspend`)
      .send({ reason: '测试停用协会 A' })
      .expect(200);
    await platform.post(`/api/admin/operators/${f.operatorA}/resume`).expect(200);
    const opAdminA = await as(f.users.operatorAdminA.email);
    const own = (
      await opAdminA.get(`/api/admin/audit-log?from=${today()}&to=${today()}`).expect(200)
    ).body.entries as { operatorId: string }[];
    expect(own.length).toBe(2);
    expect(own.every((e) => e.operatorId === f.operatorA)).toBe(true);
    const asked = (
      await opAdminA
        .get(`/api/admin/audit-log?from=${today()}&to=${today()}&operatorId=${op.id}`)
        .expect(200)
    ).body.entries;
    expect(asked).toEqual([]);
  });

  it('验收 13、14：运营商管理员、机构管理员、健管师调用开通接口一律 403，不留任何改动', async () => {
    const op = await openOperator();
    for (const email of [
      f.users.operatorAdminA.email,
      f.users.orgAdminA.email,
      f.users.managerA1.email,
    ]) {
      const agent = await as(email);
      await agent.get('/api/admin/operators').expect(403);
      await agent
        .post('/api/admin/operators')
        .send({ ...NEW_OPERATOR, slug: 'x-other' })
        .expect(403);
      await agent.get(`/api/admin/operators/${f.operatorB}`).expect(403);
      await agent.patch(`/api/admin/operators/${f.operatorB}`).send({}).expect(403);
      await agent
        .post(`/api/admin/operators/${f.operatorB}/suspend`)
        .send({ reason: '跨租户尝试停用' })
        .expect(403);
      await agent
        .post(`/api/admin/operators/${op.id}/accounts`)
        .send({
          displayName: 'x',
          email: 'x@test.example',
          role: 'operator_admin',
        })
        .expect(403);
      await agent.get(`/api/admin/operators/${f.operatorB}/accounts`).expect(403);
      await agent.post(`/api/admin/accounts/${f.users.managerB1.id}/suspend`).expect(403);
      await agent.post(`/api/admin/accounts/${f.users.managerB1.id}/reinvite`).expect(403);
    }
    for (const email of [f.users.orgAdminA.email, f.users.managerA1.email]) {
      const agent = await as(email);
      await agent.get(`/api/admin/audit-log?from=${today()}&to=${today()}`).expect(403);
    }
    const ops = await owner.selectFrom('operators').select(['id', 'status']).execute();
    expect(ops.find((o) => o.id === f.operatorB)?.status).toBe('active');
    expect(
      await owner.selectFrom('users').select('id').where('email', '=', 'x@test.example').execute(),
    ).toEqual([]);
    // 不存在的协会 404；简称、邮箱重复 409
    await platform.get('/api/admin/operators/00000000-0000-4000-8000-000000000000').expect(404);
    await platform.post('/api/admin/operators').send(NEW_OPERATOR).expect(409);
    await platform
      .post(`/api/admin/operators/${op.id}/accounts`)
      .send({ displayName: 'x', email: f.users.managerB1.email, role: 'operator_admin' })
      .expect(409);
  });

  it('验收 15：数据库层——应用角色不能直接写审计日志、读不到邀请表；非平台调用函数被拒绝', async () => {
    const app$ = withTenant;
    const db = app.get<Db>(DB);
    const ctxOp = {
      userId: f.users.operatorAdminA.id,
      role: 'operator_admin' as const,
      operatorId: f.operatorA,
      orgId: null,
    };
    await expect(
      app$(db, ctxOp, (trx) =>
        sql`insert into admin_audit_log (object_type, object_id, action) values ('user', ${f.users.managerA1.id}, 'created')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app$(db, ctxOp, (trx) => sql`delete from admin_audit_log`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app$(db, ctxOp, (trx) => sql`select * from account_invites`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app$(db, ctxOp, (trx) =>
        sql`select admin_set_operator_status(${f.operatorB}::uuid, true, '跨租户停用尝试')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app$(db, ctxOp, (trx) =>
        sql`select admin_audit(null, 'user', ${f.users.managerA1.id}::uuid, 'created', null, null)`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('验收 18：整个流程跑完，日志里搜不到邮箱、邀请令牌、链接和密码', async () => {
    const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
    const spies = methods.flatMap((m) => [vi.spyOn(Logger.prototype, m), vi.spyOn(Logger, m)]);
    try {
      const op = await openOperator();
      const invite = await inviteAdmin(op.id);
      await accept(tokenOf(invite.invitePath), 'secret-pass-789').expect(200);
      await platform.post(`/api/admin/accounts/${invite.account.id}/reinvite`).expect(200);
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
        .join('\n');
      for (const secret of [
        'm7-admin@test.example',
        tokenOf(invite.invitePath),
        'secret-pass-789',
      ]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
