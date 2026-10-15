import { DISCLAIMER } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import {
  CLEAN_CLIENT_TEXT,
  insertDraft,
  insertTask,
  SBP_FLAG,
  type Scope,
} from './work-fixtures.js';

/** 产物接口（M1 规格 3.6、验收标准 4–6、10）。 */
describe('产物接口', () => {
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

  /** A1 的任务和一份草稿 */
  async function draftA1(options: Parameters<typeof insertDraft>[3] = {}) {
    const taskId = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const id = await insertDraft(owner, scopeA1(), taskId, {
      clientId: f.clients.a1[0],
      ...options,
    });
    return { taskId, id };
  }

  const statusOf = async (id: string) =>
    (
      await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;
  const actionsOf = async (id: string) =>
    (
      await owner
        .selectFrom('artifact_events')
        .select('action')
        .where('artifact_id', '=', id)
        .orderBy('created_at')
        .execute()
    ).map((e) => e.action);

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

  it('修改草稿：免责声明删不掉也不会重复，记一条修改记录', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent
      .patch(`/api/artifacts/${id}`)
      .send({
        version: 1,
        content: { professional: '改过的专业版', clientFacing: '您的血压比较平稳。' },
      })
      .expect(200);
    expect(res.body.artifact.content).toEqual({
      professional: '改过的专业版',
      clientFacing: `您的血压比较平稳。\n\n${DISCLAIMER}`,
    });
    const again = await agent
      .patch(`/api/artifacts/${id}`)
      .send({
        version: 1,
        content: {
          professional: 'x',
          clientFacing: `（${DISCLAIMER}）您的血压比较平稳。\n\n${DISCLAIMER}`,
        },
      })
      .expect(200);
    expect(again.body.artifact.content.clientFacing).toBe(`您的血压比较平稳。\n\n${DISCLAIMER}`);
    expect(await actionsOf(id)).toEqual(['edited', 'edited']);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual(['edited']);
  });

  it('确认草稿后状态变为已审核；已审核的不能再改，也不能再确认', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(200);
    expect(res.body.artifact.status).toBe('approved');
    expect(await actionsOf(id)).toEqual(['approved']);

    await agent
      .patch(`/api/artifacts/${id}`)
      .send({ version: 1, content: { professional: 'x', clientFacing: 'y' } })
      .expect(409);
    const twice = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(409);
    expect(twice.body.reasons).toEqual(['not_latest_draft']);
  });

  it('带过期版本号确认被拒绝', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 2 }).expect(409);
    expect(res.body).toEqual({ error: 'conflict', reasons: ['not_latest_draft'] });
    expect(await statusOf(id)).toBe('draft');
  });

  it('通俗版含禁用词（插空格、零宽字符、全角）时拒绝确认，并标出位置', async () => {
    for (const bad of ['可以根治', '可以根 治', '可以根​治', '已经确　诊']) {
      const { id } = await draftA1({ clientFacing: `您的血压${bad}。\n\n${DISCLAIMER}` });
      const agent = await loginAs(app, f.users.managerA1.email);
      const res = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(409);
      expect(res.body.reasons, bad).toEqual(['banned_terms']);
      expect(res.body.bannedTerms[0].index, bad).toBe(6);
      expect(await statusOf(id)).toBe('draft');
    }
  });

  it('免责声明里的“诊断”不算禁用词', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(200);
  });

  it('没有免责声明时拒绝确认', async () => {
    const { id } = await draftA1({ clientFacing: '您的血压比较平稳。' });
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(409);
    expect(res.body.reasons).toEqual(['missing_disclaimer']);
  });

  it('有危急指标时，未勾选“已知悉”不能确认', async () => {
    const { id } = await draftA1({ criticalFlags: [SBP_FLAG] });
    const agent = await loginAs(app, f.users.managerA1.email);
    const detail = await agent.get(`/api/artifacts/${id}`).expect(200);
    expect(detail.body.artifact).toMatchObject({
      hasCriticalFlags: true,
      criticalFlags: [SBP_FLAG],
    });

    const res = await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(409);
    expect(res.body.reasons).toEqual(['critical_not_acknowledged']);
    await agent
      .post(`/api/artifacts/${id}/approve`)
      .send({ version: 1, acknowledgedCritical: true })
      .expect(200);
  });

  it('复制通俗版：只有已审核的可以，只返回通俗版，每次都有记录', async () => {
    const { id } = await draftA1({ criticalFlags: [SBP_FLAG] });
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.get(`/api/artifacts/${id}/client-text`).expect(409);

    await agent
      .post(`/api/artifacts/${id}/approve`)
      .send({ version: 1, acknowledgedCritical: true })
      .expect(200);
    const res = await agent.get(`/api/artifacts/${id}/client-text`).expect(200);
    expect(res.body).toEqual({ text: CLEAN_CLIENT_TEXT });
    expect(JSON.stringify(res.body)).not.toContain('185');
    await agent.get(`/api/artifacts/${id}/client-text`).expect(200);
    expect(await actionsOf(id)).toEqual(['approved', 'copied', 'copied']);
  });

  it('基于已审核产物修改：生成新版本草稿，旧版本和记录保留', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/revise`).expect(409);
    await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(200);

    const res = await agent.post(`/api/artifacts/${id}/revise`).expect(201);
    const v2 = res.body.artifact;
    expect(v2).toMatchObject({ version: 2, parentId: id, status: 'draft' });
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual([
      'approved',
      'created',
    ]);
    expect(await statusOf(id)).toBe('approved');

    // 旧版本不能再“基于此版修改”，新版本可以单独修改和确认
    await agent.post(`/api/artifacts/${id}/revise`).expect(409);
    await agent.post(`/api/artifacts/${v2.id}/approve`).send({ version: 1 }).expect(409);
    await agent.post(`/api/artifacts/${v2.id}/approve`).send({ version: 2 }).expect(200);
  });

  it('别人的产物：读取、修改、确认、复制、修改版本都返回 404，也不留下记录', async () => {
    const taskB = await insertTask(owner, scopeB1(), f.clients.b1);
    const artifactB = await insertDraft(owner, scopeB1(), taskB, { clientId: f.clients.b1 });
    const { id: artifactA1 } = await draftA1();
    const cases: [string, string][] = [
      [f.users.managerA1.email, artifactB],
      [f.users.managerA2.email, artifactA1],
    ];
    for (const [email, id] of cases) {
      const agent = await loginAs(app, email);
      await agent.get(`/api/artifacts/${id}`).expect(404);
      await agent
        .patch(`/api/artifacts/${id}`)
        .send({ version: 1, content: { professional: 'x', clientFacing: 'y' } })
        .expect(404);
      await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(404);
      await agent.post(`/api/artifacts/${id}/revise`).expect(404);
      await agent.get(`/api/artifacts/${id}/client-text`).expect(404);
    }
    expect(await statusOf(artifactB)).toBe('draft');
    expect(await statusOf(artifactA1)).toBe('draft');
    const events = await owner.selectFrom('artifact_events').select('id').execute();
    expect(events).toHaveLength(0);
  });

  it('管理员角色不能使用产物接口', async () => {
    const { id } = await draftA1();
    for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
      const agent = await loginAs(app, u.email);
      await agent.get(`/api/artifacts/${id}`).expect(404);
      await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(404);
    }
    await request(app.getHttpServer()).get(`/api/artifacts/${id}`).expect(401);
  });

  it('客户转出后：草稿已作废不能确认，已审核产物不能再复制', async () => {
    const { id: draft } = await draftA1();
    const { id: approved } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${approved}/approve`).send({ version: 1 }).expect(200);

    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();

    expect(await statusOf(draft)).toBe('voided');
    const res = await agent
      .post(`/api/artifacts/${draft}/approve`)
      .send({ version: 1 })
      .expect(409);
    expect(res.body.reasons).toEqual(['read_only']);
    await agent.get(`/api/artifacts/${approved}/client-text`).expect(409);
    await agent.post(`/api/artifacts/${approved}/revise`).expect(409);
    // 原健管师仍能在记录里看到
    const detail = await agent.get(`/api/artifacts/${approved}`).expect(200);
    expect(detail.body.artifact).toMatchObject({ status: 'approved', clientId: null });

    const a2 = await loginAs(app, f.users.managerA2.email);
    await a2.get(`/api/artifacts/${approved}`).expect(404);
  });

  it('请求体不合法返回 400', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/approve`).send({}).expect(400);
    await agent
      .patch(`/api/artifacts/${id}`)
      .send({ version: 1, content: { professional: 'x' } })
      .expect(400);
  });
});
