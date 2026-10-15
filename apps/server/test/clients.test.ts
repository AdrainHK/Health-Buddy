import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

describe('客户接口的租户隔离', () => {
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

  const ids = (body: { clients: { id: string }[] }) => body.clients.map((c) => c.id).sort();

  it('未登录不能访问', async () => {
    await request(app.getHttpServer()).get('/api/clients').expect(401);
    await request(app.getHttpServer()).get(`/api/clients/${f.clients.a2}`).expect(401);
  });

  it('健管师只看到自己服务的客户', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.get('/api/clients').expect(200);
    expect(ids(res.body)).toEqual([...f.clients.a1].sort());
    const one = await agent.get(`/api/clients/${f.clients.a1[0]}`).expect(200);
    expect(one.body.client).toMatchObject({ id: f.clients.a1[0], isSynthetic: true });
  });

  it('协会A的健管师读取协会B的客户，返回“不存在”', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.get(`/api/clients/${f.clients.b1}`).expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('协会B的健管师读取协会A的客户，返回“不存在”', async () => {
    const agent = await loginAs(app, f.users.managerB1.email);
    for (const id of [...f.clients.a1, f.clients.a2]) {
      await agent.get(`/api/clients/${id}`).expect(404);
    }
    const res = await agent.get('/api/clients').expect(200);
    expect(ids(res.body)).toEqual([f.clients.b1]);
  });

  it('同一协会的其他健管师也看不到', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    await agent.get(`/api/clients/${f.clients.a1[0]}`).expect(404);
  });

  it('跨租户和真的不存在的客户，响应完全一样', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const crossTenant = await agent.get(`/api/clients/${f.clients.b1}`);
    const missing = await agent.get('/api/clients/00000000-0000-4000-8000-000000000000');
    const malformed = await agent.get('/api/clients/not-a-uuid');
    for (const res of [missing, malformed]) {
      expect(res.status).toBe(crossTenant.status);
      expect(res.body).toEqual(crossTenant.body);
    }
  });

  it('机构管理员看到本机构全部客户，看不到其他协会的', async () => {
    const agent = await loginAs(app, f.users.orgAdminA.email);
    const res = await agent.get('/api/clients').expect(200);
    expect(ids(res.body)).toEqual([...f.clients.a1, f.clients.a2].sort());
    await agent.get(`/api/clients/${f.clients.b1}`).expect(404);
    // 同一协会的另一个机构也看不到
    await agent.get(`/api/clients/${f.clients.a3}`).expect(404);
  });

  it('运营商管理员和平台管理员查不到客户明细', async () => {
    for (const email of [f.users.operatorAdminA.email, f.users.platform.email]) {
      const agent = await loginAs(app, email);
      const res = await agent.get('/api/clients').expect(200);
      expect(res.body).toEqual({ clients: [] });
      await agent.get(`/api/clients/${f.clients.a1[0]}`).expect(404);
    }
  });
});
