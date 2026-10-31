import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { CRISIS_NOTICE } from '@health-buddy/skills';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 模拟厂商：记录调用次数，每次回答“好的。” */
class CountingProvider implements Provider {
  readonly name = 'openai' as const;
  calls = 0;
  async *stream(_req: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls++;
    yield { type: 'text', delta: '好的。' };
    yield {
      type: 'done',
      finishReason: 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }
}

const FEATURES_ALL = { experts: true, twin: true, care: true, companion: true };
const NO_QUOTAS = {
  llm_calls: null,
  expert_calls: null,
  report_pages: null,
  companion_devices: null,
};

/**
 * M7 第 4 步：套餐和额度（规格 2.5，验收 8、9、10、13）。平台定义套餐、设协会可售；协会分配；
 * 超额 429 quota_exceeded 且不调用模型；危机说法不受额度限制；套餐没有的功能写操作 403。合成数据。
 */
describe('套餐和额度', () => {
  const owner = ownerDb();
  const provider = new CountingProvider();
  let app: INestApplication;
  let f: Fixtures;
  let platform: Agent;
  let opA: Agent;

  const as = (email: string) => loginAs(app, email);
  const createPlan = async (over: Record<string, unknown> = {}) =>
    (
      await platform
        .post('/api/admin/plans')
        .send({
          code: 'basic',
          name: '合成基础版',
          features: FEATURES_ALL,
          monthlyQuotas: NO_QUOTAS,
          ...over,
        })
        .expect(201)
    ).body.plan as { id: string; code: string; assignedCount: number };
  /** 建套餐、设为协会 A 可售、分配给健管师 A1 */
  const assignA1 = async (over: Record<string, unknown> = {}) => {
    const plan = await createPlan(over);
    await platform
      .put(`/api/admin/operators/${f.operatorA}/plans`)
      .send({ planIds: [plan.id] })
      .expect(200);
    await opA
      .patch(`/api/admin/accounts/${f.users.managerA1.id}`)
      .send({ planId: plan.id })
      .expect(200);
    return plan;
  };
  const newTask = async (agent: Agent) =>
    (await agent.post('/api/tasks').send({}).expect(201)).body.task.id as string;
  const ask = (agent: Agent, taskId: string, content: string) =>
    agent.post(`/api/tasks/${taskId}/messages`).send({ mode: 'ask', content });

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    await owner.deleteFrom('plans').where('code', '<>', 'pilot').execute();
    platform = await as(f.users.platform.email);
    opA = await as(f.users.operatorAdminA.email);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('平台定义套餐、设协会可售；协会只看到可售的，只能分配给本协会健管师；有审计', async () => {
    const plan = await createPlan();
    await platform
      .post('/api/admin/plans')
      .send({ code: 'basic', name: 'x', features: FEATURES_ALL, monthlyQuotas: NO_QUOTAS })
      .expect(409);
    await platform
      .post('/api/admin/plans')
      .send({ code: 'Bad Code', name: 'x', features: FEATURES_ALL, monthlyQuotas: NO_QUOTAS })
      .expect(400);
    // 协会还没有可售套餐：列表为空，分配被拒绝
    expect((await opA.get('/api/admin/plans').expect(200)).body.plans).toEqual([]);
    expect(
      (
        await opA
          .patch(`/api/admin/accounts/${f.users.managerA1.id}`)
          .send({ planId: plan.id })
          .expect(400)
      ).body,
    ).toEqual({ error: 'plan_not_available' });
    await platform
      .put(`/api/admin/operators/${f.operatorA}/plans`)
      .send({ planIds: [plan.id] })
      .expect(200);
    expect(
      (await platform.get(`/api/admin/operators/${f.operatorA}/plans`).expect(200)).body,
    ).toEqual({ planIds: [plan.id] });
    const visible = (await opA.get('/api/admin/plans').expect(200)).body.plans as {
      code: string;
      assignedCount: null;
    }[];
    expect(visible.map((p) => p.code)).toEqual(['basic']);
    expect(visible[0]!.assignedCount).toBeNull();
    await opA
      .patch(`/api/admin/accounts/${f.users.managerA1.id}`)
      .send({ planId: plan.id })
      .expect(200);
    const listed = (await platform.get('/api/admin/plans').expect(200)).body.plans as {
      code: string;
      assignedCount: number;
    }[];
    expect(listed.find((p) => p.code === 'basic')?.assignedCount).toBe(1);
    // 修改：代码不变
    const updated = (
      await platform
        .patch(`/api/admin/plans/${plan.id}`)
        .send({
          name: '合成基础版二',
          features: FEATURES_ALL,
          monthlyQuotas: { ...NO_QUOTAS, llm_calls: 5 },
        })
        .expect(200)
    ).body.plan;
    expect(updated).toMatchObject({
      code: 'basic',
      name: '合成基础版二',
      monthlyQuotas: { llm_calls: 5 },
    });
    // 停售：协会看不到，不能再分配；试点版不能停售
    await platform.post(`/api/admin/plans/${plan.id}/retire`).expect(200);
    expect((await opA.get('/api/admin/plans').expect(200)).body.plans).toEqual([]);
    await opA
      .patch(`/api/admin/accounts/${f.users.managerA2.id}`)
      .send({ planId: plan.id })
      .expect(400);
    const pilot = (await platform.get('/api/admin/plans').expect(200)).body.plans.find(
      (p: { code: string }) => p.code === 'pilot',
    );
    await platform.post(`/api/admin/plans/${pilot.id}/retire`).expect(400);
    const audit = await owner
      .selectFrom('admin_audit_log')
      .select(['object_type', 'action'])
      .execute();
    expect(
      audit
        .filter((a) => a.object_type === 'plan')
        .map((a) => a.action)
        .sort(),
    ).toEqual(['created', 'retired', 'updated']);
    expect(audit.some((a) => a.action === 'plan_assigned')).toBe(true);
  });

  it('验收 13：协会 A 给 B 的账号分配、动 B 的可售套餐一律拒绝；非平台不能改套餐', async () => {
    const plan = await assignA1();
    await opA
      .patch(`/api/admin/accounts/${f.users.managerB1.id}`)
      .send({ planId: plan.id })
      .expect(404);
    await opA
      .patch(`/api/admin/accounts/${f.users.orgAdminA.id}`)
      .send({ planId: plan.id })
      .expect(404);
    for (const email of [
      f.users.operatorAdminA.email,
      f.users.orgAdminA.email,
      f.users.managerA1.email,
    ]) {
      const agent = await as(email);
      await agent
        .post('/api/admin/plans')
        .send({ code: 'x', name: 'x', features: FEATURES_ALL, monthlyQuotas: NO_QUOTAS })
        .expect(403);
      await agent
        .patch(`/api/admin/plans/${plan.id}`)
        .send({ name: 'x', features: FEATURES_ALL, monthlyQuotas: NO_QUOTAS })
        .expect(403);
      await agent
        .put(`/api/admin/operators/${f.operatorB}/plans`)
        .send({ planIds: [plan.id] })
        .expect(403);
    }
    const orgAdmin = await as(f.users.orgAdminA.email);
    await orgAdmin.get('/api/admin/plans').expect(403);
    await orgAdmin
      .patch(`/api/admin/accounts/${f.users.managerA1.id}`)
      .send({ planId: plan.id })
      .expect(403);
    expect(await owner.selectFrom('user_plans').select('user_id').execute()).toEqual([
      { user_id: f.users.managerA1.id },
    ]);

    // 数据库层：伪造会话直接调用
    const db = app.get<Db>(DB);
    const ctxOp = {
      userId: f.users.operatorAdminA.id,
      role: 'operator_admin' as const,
      operatorId: f.operatorA,
      orgId: null,
    };
    const ctxMgr = {
      userId: f.users.managerA1.id,
      role: 'manager' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    await expect(
      withTenant(db, ctxOp, (trx) =>
        sql`select admin_save_plan(null, 'x', 'x', '{}'::jsonb, '{}'::jsonb)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(db, ctxOp, (trx) =>
        sql`select admin_set_operator_plans(${f.operatorA}::uuid, '{}'::uuid[])`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(db, ctxMgr, (trx) =>
        sql`select admin_assign_plan(${f.users.managerA2.id}::uuid, ${plan.id}::uuid)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 伪造协会：账号本身属于 A
    await expect(
      withTenant(db, { ...ctxOp, operatorId: f.operatorB }, (trx) =>
        sql`select admin_assign_plan(${f.users.managerB1.id}::uuid, ${plan.id}::uuid)`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 用量表只能经函数写
    await expect(
      withTenant(db, ctxMgr, (trx) =>
        sql`insert into quota_usage_daily (user_id, day, metric, count) values (${f.users.managerA1.id}, current_date, 'llm_calls', 0)`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('验收 9：大模型调用额度用完后 429 quota_exceeded，不调用模型；危机说法照常生成并带固定提示', async () => {
    await assignA1({ monthlyQuotas: { ...NO_QUOTAS, llm_calls: 1 } });
    const m = await as(f.users.managerA1.email);
    const taskId = await newTask(m);
    await ask(m, taskId, '高血压客户的运动建议有哪些').expect(200);
    const before = provider.calls;
    const res = await ask(m, taskId, '再说详细一点').expect(429);
    expect(res.body).toEqual({ error: 'quota_exceeded', metric: 'llm_calls' });
    expect(provider.calls).toBe(before);
    // 危机：不受额度限制（红线 4）
    const crisis = await ask(m, taskId, '客户说活不下去了，怎么办').expect(200);
    expect(crisis.text).toContain(CRISIS_NOTICE);
    // 别的健管师（试点版，不另设额度）不受影响
    const other = await as(f.users.managerA2.email);
    await ask(other, await newTask(other), '你好').expect(200);

    // 验收 10：我的账号
    const plan = (await m.get('/api/me/plan').expect(200)).body.plan;
    expect(plan).toMatchObject({
      code: 'basic',
      name: '合成基础版',
      monthlyQuotas: { llm_calls: 1 },
      usage: { llm_calls: 2, expert_calls: 0, report_pages: 0 },
    });
    expect((await other.get('/api/me/plan').expect(200)).body.plan).toMatchObject({
      code: 'pilot',
      name: '试点版',
    });
    await opA.get('/api/me/plan').expect(403);
  });

  it('额度并发：两个请求同时用最后 1 次额度，只成功一个', async () => {
    await assignA1({ monthlyQuotas: { ...NO_QUOTAS, llm_calls: 1 } });
    const db = app.get<Db>(DB);
    const ctx = {
      userId: f.users.managerA1.id,
      role: 'manager' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        withTenant(db, ctx, async (trx) => {
          const { rows } = await sql<{
            ok: boolean;
          }>`select quota_consume('llm_calls', 1, false) as ok`.execute(trx);
          return rows[0]!.ok;
        }),
      ),
    );
    expect(results.sort()).toEqual([false, true]);
  });

  it('验收 8：套餐关掉专家中心、方案与随访后，写操作 403 plan_feature_disabled，只读照常', async () => {
    await assignA1({ features: { ...FEATURES_ALL, experts: false, care: false } });
    const m = await as(f.users.managerA1.email);
    await m.get('/api/experts').expect(200);
    expect(
      (
        await m
          .put('/api/expert-calls/00000000-0000-4000-8000-000000000000/feedback')
          .send({})
          .expect(403)
      ).body,
    ).toEqual({ error: 'plan_feature_disabled', feature: 'experts' });
    await m.get(`/api/clients/${f.clients.a1[0]}/care-plans`).expect(200);
    await m.post('/api/care-plans/00000000-0000-4000-8000-000000000000/end').send({}).expect(403);
    // 对话里直接 @专家 403
    const taskId = await newTask(m);
    await m
      .post(`/api/tasks/${taskId}/messages`)
      .send({ mode: 'ask', content: '请看看', expertRefs: ['nutrition'] })
      .expect(403);
    // 别的健管师（试点版）不受影响：同样的请求按正常流程处理（参数或对象不对），不是 403
    const other = await as(f.users.managerA2.email);
    const res = await other
      .post('/api/care-plans/00000000-0000-4000-8000-000000000000/end')
      .send({});
    expect(res.status).not.toBe(403);
  });
});
