import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, PASSWORD, seedFixtures, type Fixtures } from './fixtures.js';

describe('登录、会话和退出', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  const http = () => request(app.getHttpServer());

  it('正确的账号密码可以登录，Cookie 是 httpOnly 和 SameSite=Lax', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ email: f.users.managerA1.email, password: PASSWORD })
      .expect(200);
    expect(res.body.user).toMatchObject({
      id: f.users.managerA1.id,
      role: 'manager',
      operator: { id: f.operatorA, name: '测试协会A' },
      orgId: f.orgA,
    });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/hb_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('邮箱不区分大小写', async () => {
    await http()
      .post('/api/auth/login')
      .send({ email: f.users.managerA2.email.toUpperCase(), password: PASSWORD })
      .expect(200);
  });

  it('会话表里不保存令牌明文', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ email: f.users.managerB1.email, password: PASSWORD })
      .expect(200);
    const token = /hb_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1] ?? '';
    const rows = await owner.selectFrom('sessions').select('token_hash').execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Buffer.from(row.token_hash as Buffer).toString('utf8')).not.toContain(token);
      expect((row.token_hash as Buffer).length).toBe(32);
    }
  });

  it('密码错误和邮箱不存在返回同样的错误', async () => {
    const wrong = await http()
      .post('/api/auth/login')
      .send({ email: f.users.orgAdminA.email, password: 'wrong password' })
      .expect(401);
    const unknown = await http()
      .post('/api/auth/login')
      .send({ email: 'nobody@test.example', password: 'wrong password' })
      .expect(401);
    expect(wrong.body).toEqual({ error: 'invalid_credentials' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('停用的账号、停用协会下的账号都不能登录', async () => {
    for (const email of [f.users.disabledManagerA.email, f.users.suspendedOperatorManager.email]) {
      const res = await http()
        .post('/api/auth/login')
        .send({ email, password: PASSWORD })
        .expect(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    }
  });

  it('请求格式不对返回 bad_request，且不回显内容', async () => {
    const malformed = await http()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.c", "password": "secret-value"')
      .expect(400);
    expect(malformed.body).toEqual({ error: 'bad_request' });
    await http().post('/api/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
  });

  it('登录后可以取当前用户；退出后会话失效', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe(f.users.managerA1.email);

    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('退出后旧令牌即使被重放也无效', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ email: f.users.managerA1.email, password: PASSWORD })
      .expect(200);
    const cookie = /hb_session=[^;]+/.exec(String(res.headers['set-cookie']))?.[0] ?? '';
    await http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    await http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await http().get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('没有会话、伪造的会话都返回 401', async () => {
    await http().get('/api/auth/me').expect(401);
    await http().get('/api/auth/me').set('Cookie', 'hb_session=garbage').expect(401);
    await http()
      .get('/api/auth/me')
      .set('Cookie', `hb_session=${'A'.repeat(43)}`)
      .expect(401);
  });

  it('账号被停用后，已有会话立即失效', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    await agent.get('/api/auth/me').expect(200);
    await owner
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('id', '=', f.users.managerA2.id)
      .execute();
    try {
      await agent.get('/api/auth/me').expect(401);
    } finally {
      await owner
        .updateTable('users')
        .set({ status: 'active' })
        .where('id', '=', f.users.managerA2.id)
        .execute();
    }
  });

  it('空闲超过 3 天的会话失效', async () => {
    const agent = await loginAs(app, f.users.orgAdminA2.email);
    await agent.get('/api/auth/me').expect(200);
    await owner
      .updateTable('sessions')
      .set({ last_seen_at: sql`now() - interval '3 days 1 minute'` })
      .where('user_id', '=', f.users.orgAdminA2.id)
      .execute();
    await agent.get('/api/auth/me').expect(401);
  });

  it('跨站发起的修改请求被拒绝', async () => {
    const res = await http()
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: f.users.managerA1.email, password: PASSWORD })
      .expect(403);
    expect(res.body).toEqual({ error: 'forbidden_origin' });
    await http().post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
  });

  it('同源发起的请求正常通过', async () => {
    const server = http();
    await server
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ email: f.users.managerA1.email, password: PASSWORD })
      .expect(200);
  });

  it('同一邮箱连续输错5次后暂时锁定，正确密码也不行', async () => {
    const email = f.users.operatorAdminB.email;
    for (let i = 0; i < 5; i++) {
      await http().post('/api/auth/login').send({ email, password: 'wrong' }).expect(401);
    }
    const res = await http()
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(429);
    expect(res.body).toEqual({ error: 'too_many_requests' });
  });

  it('健康检查无需登录', async () => {
    await http().get('/api/health').expect(200, { status: 'ok' });
  });

  it('不存在的接口返回 not_found', async () => {
    const res = await http().get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
