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

type Agent = Awaited<ReturnType<typeof loginAs>>;

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

  /** 以所有者身份把一份草稿直接改成已审核 */
  async function approvedB1() {
    const taskId = await insertTask(owner, scopeB1(), f.clients.b1);
    const id = await insertDraft(owner, scopeB1(), taskId, { clientId: f.clients.b1 });
    await owner.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute();
    return id;
  }

  const statusOf = async (id: string) =>
    (
      await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;
  const eventsOf = (id: string) =>
    owner
      .selectFrom('artifact_events')
      .select(['action', 'reason'])
      .where('artifact_id', '=', id)
      .orderBy('created_at')
      .execute();
  const actionsOf = async (id: string) => (await eventsOf(id)).map((e) => e.action);

  /** 健管师预览时拿到的内容指纹 */
  const hashOf = async (agent: Agent, id: string) =>
    (await agent.get(`/api/artifacts/${id}`).expect(200)).body.artifact.contentHash as string;
  const approve = async (
    agent: Agent,
    id: string,
    extra: Record<string, unknown> = {},
    version = 1,
  ) => {
    // 先取指纹再发请求：supertest 的请求对象一创建就开始监听
    const contentHash = await hashOf(agent, id);
    return agent.post(`/api/artifacts/${id}/approve`).send({ version, contentHash, ...extra });
  };
  const edit = async (agent: Agent, id: string, clientFacing: string, professional = '专业版') => {
    const contentHash = await hashOf(agent, id);
    return agent
      .patch(`/api/artifacts/${id}`)
      .send({ version: 1, contentHash, content: { professional, clientFacing } });
  };

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
    const res = await edit(agent, id, '您的血压比较平稳。', '改过的专业版');
    expect(res.status).toBe(200);
    expect(res.body.artifact.content).toEqual({
      professional: '改过的专业版',
      clientFacing: `您的血压比较平稳。\n\n${DISCLAIMER}`,
    });
    const again = await edit(
      agent,
      id,
      `（${DISCLAIMER}）您的血压比较平稳。仅供参考 ，非医疗\u200B诊断\n\n${DISCLAIMER}`,
    );
    expect(again.status).toBe(200);
    expect(again.body.artifact.content.clientFacing).toBe(`您的血压比较平稳。\n\n${DISCLAIMER}`);
    expect(await actionsOf(id)).toEqual(['edited', 'edited']);
  });

  it('确认草稿后状态变为已审核；已审核的不能再改，也不能再确认', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await approve(agent, id);
    expect(res.status).toBe(200);
    expect(res.body.artifact.status).toBe('approved');
    expect(await eventsOf(id)).toEqual([{ action: 'approved', reason: null }]);

    expect((await edit(agent, id, 'x')).status).toBe(409);
    const twice = await approve(agent, id);
    expect(twice.status).toBe(409);
    expect(twice.body.reasons).toEqual(['not_latest_draft']);
  });

  it('带过期版本号或过期内容指纹确认被拒绝（别的窗口改过）', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const stale = await approve(agent, id, {}, 2);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'conflict', reasons: ['not_latest_draft'] });

    // 预览之后，另一个窗口改了内容
    const previewed = await hashOf(agent, id);
    expect((await edit(agent, id, '另一个窗口改的。')).status).toBe(200);
    const res = await agent
      .post(`/api/artifacts/${id}/approve`)
      .send({ version: 1, contentHash: previewed })
      .expect(409);
    expect(res.body.reasons).toEqual(['not_latest_draft']);
    // 用过期指纹保存同样被拒绝，不会悄悄覆盖
    await agent
      .patch(`/api/artifacts/${id}`)
      .send({
        version: 1,
        contentHash: previewed,
        content: { professional: 'x', clientFacing: 'y' },
      })
      .expect(409);
    expect(await statusOf(id)).toBe('draft');
  });

  it('通俗版含禁用词（插空格、零宽字符、分隔符、全角、繁体）时拒绝确认，并标出位置', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    for (const bad of [
      '可以根治',
      '可以根 治',
      '可以根\u200B治',
      '可以根·治',
      '已经确\u3000诊',
      '已經確診',
    ]) {
      const { id } = await draftA1({ clientFacing: `您的血压${bad}。\n\n${DISCLAIMER}` });
      const res = await approve(agent, id);
      expect(res.status, bad).toBe(409);
      expect(res.body.reasons, bad).toEqual(['banned_terms']);
      expect(res.body.bannedTerms[0].index, bad).toBe(6);
      expect(await statusOf(id)).toBe('draft');
    }
  });

  it('免责声明里的“诊断”不算禁用词', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    expect((await approve(agent, id)).status).toBe(200);
  });

  it('没有免责声明、免责声明重复、正文为空时拒绝确认', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const cases: [string, string][] = [
      ['您的血压比较平稳。', 'missing_disclaimer'],
      [`${DISCLAIMER}。您的血压比较平稳。\n\n${DISCLAIMER}`, 'duplicate_disclaimer'],
      [`\n\n${DISCLAIMER}`, 'empty_client_text'],
    ];
    for (const [text, reason] of cases) {
      const { id } = await draftA1({ clientFacing: text });
      const res = await approve(agent, id);
      expect(res.status, reason).toBe(409);
      expect(res.body.reasons, reason).toEqual([reason]);
    }
  });

  it('有危急指标时，未勾选“已知悉”不能确认；确认记录里记下“已知悉”', async () => {
    const { id } = await draftA1({ criticalFlags: [SBP_FLAG] });
    const agent = await loginAs(app, f.users.managerA1.email);
    const detail = await agent.get(`/api/artifacts/${id}`).expect(200);
    expect(detail.body.artifact).toMatchObject({
      hasCriticalFlags: true,
      criticalFlags: [SBP_FLAG],
    });

    const res = await approve(agent, id);
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['critical_not_acknowledged']);
    expect((await approve(agent, id, { acknowledgedCritical: true })).status).toBe(200);
    expect(await eventsOf(id)).toEqual([{ action: 'approved', reason: 'critical_acknowledged' }]);
  });

  it('通俗版里出现危急指标的数值时拒绝确认', async () => {
    const { id } = await draftA1({
      criticalFlags: [SBP_FLAG],
      clientFacing: `您最近一次收缩压 185，请注意休息。\n\n${DISCLAIMER}`,
    });
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await approve(agent, id, { acknowledgedCritical: true });
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['critical_value_in_client_text']);
    expect(res.body.criticalValueMentions).toEqual([{ metric: 'sbp', index: 9 }]);
  });

  it('详情里返回通俗版的疾病名称提示，只提示不拦截', async () => {
    const { id } = await draftA1({ clientFacing: `您的血压偏高，有高血压风险。\n\n${DISCLAIMER}` });
    const agent = await loginAs(app, f.users.managerA1.email);
    const detail = await agent.get(`/api/artifacts/${id}`).expect(200);
    expect(detail.body.hints.judgementHints.length).toBeGreaterThan(0);
    expect((await approve(agent, id)).status).toBe(200);
  });

  it('复制通俗版：只有已审核的可以，只返回通俗版和产品名称，每次都有记录', async () => {
    const { id } = await draftA1({ criticalFlags: [SBP_FLAG] });
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/copy`).expect(409);

    expect((await approve(agent, id, { acknowledgedCritical: true })).status).toBe(200);
    const res = await agent.post(`/api/artifacts/${id}/copy`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ text: `${CLEAN_CLIENT_TEXT}\n\n— Health Buddy` });
    expect(res.body.text).not.toContain('185');
    expect(res.body.text).not.toContain('专业');
    await agent.post(`/api/artifacts/${id}/copy`).expect(200);
    expect(await actionsOf(id)).toEqual(['approved', 'copied', 'copied']);
  });

  it('基于已审核产物修改：生成新版本草稿，旧版本和记录保留', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/revise`).expect(409);
    expect((await approve(agent, id)).status).toBe(200);

    const res = await agent.post(`/api/artifacts/${id}/revise`).expect(201);
    const v2 = res.body.artifact;
    expect(v2).toMatchObject({ version: 2, parentId: id, status: 'draft' });
    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual([
      'approved',
      'created',
    ]);
    expect(await statusOf(id)).toBe('approved');

    await agent.post(`/api/artifacts/${id}/revise`).expect(409);
    expect((await approve(agent, v2.id, {}, 1)).status).toBe(409);
    expect((await approve(agent, v2.id, {}, 2)).status).toBe(200);
  });

  it('并发：两次确认只成功一次；三次“基于此版修改”只生成一个新版本', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const hash = await hashOf(agent, id);
    const approvals = await Promise.all(
      [0, 1].map(() =>
        agent.post(`/api/artifacts/${id}/approve`).send({ version: 1, contentHash: hash }),
      ),
    );
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);

    const revisions = await Promise.all(
      [0, 1, 2].map(() => agent.post(`/api/artifacts/${id}/revise`)),
    );
    expect(revisions.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('别人的产物（草稿和已审核）：每个接口都返回 404，响应和不存在完全一样，也不留下记录', async () => {
    const taskB = await insertTask(owner, scopeB1(), f.clients.b1);
    const draftB = await insertDraft(owner, scopeB1(), taskB, { clientId: f.clients.b1 });
    const approvedB = await approvedB1();
    const { id: draftOfA1 } = await draftA1();
    const cases: [string, string][] = [
      [f.users.managerA1.email, draftB],
      [f.users.managerA1.email, approvedB],
      [f.users.managerA2.email, draftOfA1],
    ];
    const body = {
      version: 1,
      contentHash: 'x',
      content: { professional: 'x', clientFacing: 'y' },
    };
    const calls = (agent: Agent, id: string) => [
      agent.get(`/api/artifacts/${id}`),
      agent.patch(`/api/artifacts/${id}`).send(body),
      agent.post(`/api/artifacts/${id}/approve`).send(body),
      agent.post(`/api/artifacts/${id}/revise`),
      agent.post(`/api/artifacts/${id}/copy`),
    ];
    for (const [email, id] of cases) {
      const agent = await loginAs(app, email);
      const missing = await Promise.all(calls(agent, '00000000-0000-4000-8000-000000000000'));
      const malformed = await Promise.all(calls(agent, 'not-a-uuid'));
      const cross = await Promise.all(calls(agent, id));
      cross.forEach((res, i) => {
        expect(res.status, `${email} ${i}`).toBe(404);
        expect(res.body).toEqual(missing[i]?.body);
        expect(res.body).toEqual(malformed[i]?.body);
      });
    }
    expect(await statusOf(draftB)).toBe('draft');
    expect(await statusOf(approvedB)).toBe('approved');
    expect(await statusOf(draftOfA1)).toBe('draft');
    const events = await owner.selectFrom('artifact_events').select('id').execute();
    expect(events).toHaveLength(0);
    const versions = await owner.selectFrom('artifacts').select('id').execute();
    expect(versions).toHaveLength(3);
  });

  it('管理员角色不能使用任何产物接口', async () => {
    const { id } = await draftA1();
    const body = {
      version: 1,
      contentHash: 'x',
      content: { professional: 'x', clientFacing: 'y' },
    };
    for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
      const agent = await loginAs(app, u.email);
      await agent.get(`/api/artifacts/${id}`).expect(404);
      await agent.patch(`/api/artifacts/${id}`).send(body).expect(404);
      await agent.post(`/api/artifacts/${id}/approve`).send(body).expect(404);
      await agent.post(`/api/artifacts/${id}/revise`).expect(404);
      await agent.post(`/api/artifacts/${id}/copy`).expect(404);
    }
    const http = request(app.getHttpServer());
    await http.get(`/api/artifacts/${id}`).expect(401);
    await http.post(`/api/artifacts/${id}/copy`).expect(401);
  });

  it('客户转出后：草稿已作废不能修改和确认，已审核产物不能再复制或修改版本', async () => {
    const { id: draft } = await draftA1();
    const { id: approved } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    const draftHash = await hashOf(agent, draft);
    expect((await approve(agent, approved)).status).toBe(200);

    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();

    expect(await statusOf(draft)).toBe('voided');
    const res = await agent
      .post(`/api/artifacts/${draft}/approve`)
      .send({ version: 1, contentHash: draftHash })
      .expect(409);
    expect(res.body.reasons).toEqual(['read_only']);
    await agent
      .patch(`/api/artifacts/${draft}`)
      .send({
        version: 1,
        contentHash: draftHash,
        content: { professional: 'x', clientFacing: 'y' },
      })
      .expect(409);
    await agent.post(`/api/artifacts/${approved}/copy`).expect(409);
    await agent.post(`/api/artifacts/${approved}/revise`).expect(409);
    // 原健管师仍能在记录里看到
    const detail = await agent.get(`/api/artifacts/${approved}`).expect(200);
    expect(detail.body.artifact).toMatchObject({ status: 'approved', clientId: null });

    // 新健管师看不到，也不能复制或修改版本
    const a2 = await loginAs(app, f.users.managerA2.email);
    await a2.get(`/api/artifacts/${approved}`).expect(404);
    await a2.post(`/api/artifacts/${approved}/copy`).expect(404);
    await a2.post(`/api/artifacts/${approved}/revise`).expect(404);
  });

  it('请求体不合法返回 400', async () => {
    const { id } = await draftA1();
    const agent = await loginAs(app, f.users.managerA1.email);
    await agent.post(`/api/artifacts/${id}/approve`).send({}).expect(400);
    await agent.post(`/api/artifacts/${id}/approve`).send({ version: 1 }).expect(400);
    await agent
      .patch(`/api/artifacts/${id}`)
      .send({ version: 1, contentHash: 'x', content: { professional: 'x' } })
      .expect(400);
  });
});
