import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { insertDraft, insertTask, type Scope } from './work-fixtures.js';

/** 任务接口（M1 规格第六节）：只对健管师本人开放，跨租户一律 404。 */
describe('任务接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  const scopeA1 = (): Scope => ({
    operatorId: f.operatorA,
    orgId: f.orgA,
    managerId: f.users.managerA1.id,
  });
  const scopeB1 = (): Scope => ({
    operatorId: f.operatorB,
    orgId: f.orgB,
    managerId: f.users.managerB1.id,
  });

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('未登录不能访问', async () => {
    const http = request(app.getHttpServer());
    await http.get('/api/tasks').expect(401);
    await http.post('/api/tasks').send({}).expect(401);
  });

  it('健管师新建、改名、归档和取消归档任务', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const created = await agent.post('/api/tasks').send({ clientId: f.clients.a1[0] }).expect(201);
    expect(created.body.task).toMatchObject({
      title: '新任务',
      clientId: f.clients.a1[0],
      archived: false,
      detachedReason: null,
    });
    const id = created.body.task.id as string;

    await agent.patch(`/api/tasks/${id}`).send({ title: '近况小结' }).expect(200);
    const archived = await agent.patch(`/api/tasks/${id}`).send({ archived: true }).expect(200);
    expect(archived.body.task).toMatchObject({ title: '近况小结', archived: true });

    expect((await agent.get('/api/tasks').expect(200)).body.tasks).toHaveLength(0);
    const archivedList = await agent.get('/api/tasks?archived=true').expect(200);
    expect(archivedList.body.tasks.map((t: { id: string }) => t.id)).toEqual([id]);

    await agent.patch(`/api/tasks/${id}`).send({ archived: false }).expect(200);
    const byClient = await agent.get(`/api/tasks?clientId=${f.clients.a1[0]}`).expect(200);
    expect(byClient.body.tasks).toHaveLength(1);
    const otherClient = await agent.get(`/api/tasks?clientId=${f.clients.a1[1]}`).expect(200);
    expect(otherClient.body.tasks).toHaveLength(0);
  });

  it('请求体不合法返回 400', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post('/api/tasks').send({ title: '' }).expect(400);
    const created = await agent.post('/api/tasks').send({}).expect(201);
    await agent.patch(`/api/tasks/${created.body.task.id}`).send({}).expect(400);
    await agent
      .patch(`/api/tasks/${created.body.task.id}`)
      .send({ title: 'x'.repeat(101) })
      .expect(400);
  });

  it('不能用别人的客户新建任务或筛选任务', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    for (const clientId of [f.clients.a2, f.clients.b1, f.clients.a3]) {
      await agent.post('/api/tasks').send({ clientId }).expect(404);
      await agent.get(`/api/tasks?clientId=${clientId}`).expect(404);
    }
    await agent.get('/api/tasks?clientId=not-a-uuid').expect(404);
    const tasks = await owner.selectFrom('tasks').select('id').execute();
    expect(tasks).toHaveLength(0);
  });

  it('看不到、改不了别人的任务（跨协会和同协会）', async () => {
    const taskB = await insertTask(owner, scopeB1(), f.clients.b1);
    const taskA1 = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const cases: [string, string][] = [
      [f.users.managerA1.email, taskB],
      [f.users.managerA2.email, taskA1],
    ];
    for (const [email, taskId] of cases) {
      const agent = await loginAs(app, email);
      await agent.get(`/api/tasks/${taskId}`).expect(404);
      await agent.patch(`/api/tasks/${taskId}`).send({ title: '改名' }).expect(404);
      for (const path of ['/api/tasks', '/api/tasks?archived=true']) {
        const list = await agent.get(path).expect(200);
        expect(list.body.tasks.map((t: { id: string }) => t.id)).not.toContain(taskId);
      }
    }
    const unchanged = await owner
      .selectFrom('tasks')
      .select('title')
      .where('id', 'in', [taskB, taskA1])
      .execute();
    expect(unchanged.every((t) => t.title === '测试任务')).toBe(true);
  });

  it('跨租户和真的不存在的任务，响应完全一样', async () => {
    const taskB = await insertTask(owner, scopeB1());
    const agent = await loginAs(app, f.users.managerA1.email);
    const cross = await agent.get(`/api/tasks/${taskB}`);
    for (const path of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await agent.get(`/api/tasks/${path}`);
      expect(res.status).toBe(cross.status);
      expect(res.body).toEqual(cross.body);
    }
  });

  it('机构管理员、协会管理员和平台管理员不能使用任务接口', async () => {
    const taskA1 = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
      const agent = await loginAs(app, u.email);
      await agent.get('/api/tasks').expect(404);
      await agent.post('/api/tasks').send({}).expect(404);
      await agent.get(`/api/tasks/${taskA1}`).expect(404);
      await agent.patch(`/api/tasks/${taskA1}`).send({ archived: true }).expect(404);
    }
  });

  it('任务详情包含产物摘要', async () => {
    const taskId = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const artifactId = await insertDraft(owner, scopeA1(), taskId, { clientId: f.clients.a1[0] });
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.get(`/api/tasks/${taskId}`).expect(200);
    expect(res.body.task.id).toBe(taskId);
    expect(res.body.artifacts).toEqual([
      expect.objectContaining({
        id: artifactId,
        status: 'draft',
        version: 1,
        hasCriticalFlags: false,
      }),
    ]);
    expect(res.body.messages).toEqual([]);
  });

  it('客户转出后任务只读：不能改名、不能取消归档，返回 409', async () => {
    const taskId = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const agent = await loginAs(app, f.users.managerA1.email);
    const detail = await agent.get(`/api/tasks/${taskId}`).expect(200);
    expect(detail.body.task).toMatchObject({
      clientId: null,
      archived: true,
      detachedReason: 'client_transferred',
    });
    const res = await agent.patch(`/api/tasks/${taskId}`).send({ archived: false }).expect(409);
    expect(res.body).toEqual({ error: 'conflict', reasons: ['read_only'] });
    await agent.patch(`/api/tasks/${taskId}`).send({ title: '改名' }).expect(409);

    // 新健管师看不到原来的任务
    const a2 = await loginAs(app, f.users.managerA2.email);
    await a2.get(`/api/tasks/${taskId}`).expect(404);
    const list = await a2.get(`/api/tasks?clientId=${f.clients.a1[0]}`).expect(200);
    expect(list.body.tasks).toHaveLength(0);
  });
});
