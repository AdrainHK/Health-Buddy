import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Db, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

const ROUTING = JSON.stringify({ selected: [], excluded: [], overCap: [], ruleOnly: false });
const OPINION = JSON.stringify({
  inScope: true,
  outOfScopeNote: null,
  summary: '合成意见',
  findings: [],
  suggestions: [],
  referral: { needed: false, urgency: null, to: null, reason: null },
  questionsToAsk: [],
  dataGaps: [],
  crisisSignal: false,
  emergencySignal: false,
});

/** 统计行允许出现的字段：只有协会、专家、日期和汇总数字（规格 6.2） */
const ROW_KEYS = [
  'operatorId',
  'operatorName',
  'expertId',
  'expertName',
  'date',
  'calls',
  'succeeded',
  'timedOut',
  'successRate',
  'timeoutRate',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'useful',
  'notUseful',
].sort();

interface PlannedCall {
  expertId: string;
  status: 'done' | 'timeout' | 'failed';
  tokens?: [number, number];
  rating?: 'useful' | 'not_useful';
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * 专家后台统计和平台专家管理（M3 规格 1.3、6.2、6.4，验收第 25 条）。全部是合成数据。
 * 每个新接口都有“跨租户访问被拒绝”的测试；统计函数另外以应用角色直接连接检查。
 */
describe('专家统计和平台专家管理', () => {
  const owner = ownerDb();
  let appDb: Db;
  let server: INestApplication;
  let f: Fixtures;

  const as = (u: Account) => loginAs(server, u.email);
  const ctxOf = (
    u: Account,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: u.id, role, operatorId, orgId });

  /** 以健管师本人的身份建一次专家调用，按计划结束每位专家并给反馈 */
  async function seedCalls(ctx: TenantContext, calls: PlannedCall[]) {
    const scope = { operator_id: ctx.operatorId!, org_id: ctx.orgId, manager_id: ctx.userId };
    return withTenant(appDb, ctx, async (trx) => {
      const task = await trx
        .insertInto('tasks')
        .values({ ...scope, title: '测试任务' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const message = await trx
        .insertInto('task_messages')
        .values({
          ...scope,
          task_id: task.id,
          role: 'assistant',
          mode: 'ask',
          content: '',
          status: 'streaming',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const consultation = await trx
        .insertInto('expert_consultations')
        .values({
          ...scope,
          task_id: task.id,
          message_id: message.id,
          trigger: 'mention',
          routing: ROUTING,
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const callIds: string[] = [];
      for (const c of calls) {
        const call = await trx
          .insertInto('expert_calls')
          .values({
            ...scope,
            consultation_id: consultation.id,
            expert_id: c.expertId,
            expert_version: '0.1.0',
            sources_version: '0123456789ab',
            selected_reason: 'manager',
            status: 'running',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('expert_calls')
          .set({
            status: c.status,
            opinion: c.status === 'done' ? OPINION : null,
            failure_category: c.status === 'timeout' ? 'timeout' : null,
            input_tokens: c.tokens?.[0] ?? 0,
            output_tokens: c.tokens?.[1] ?? 0,
          })
          .where('id', '=', call.id)
          .execute();
        if (c.rating) {
          await trx
            .insertInto('expert_feedback')
            .values({ ...scope, expert_call_id: call.id, rating: c.rating })
            .execute();
        }
        callIds.push(call.id);
      }
      await trx
        .updateTable('expert_consultations')
        .set({ status: 'done', synthesis_status: 'skipped' })
        .where('id', '=', consultation.id)
        .execute();
      return { taskId: task.id as string, callIds };
    });
  }

  /** 模型网关的计量行（费用估算来自这里） */
  async function seedUsage(operatorId: string, userId: string, expertId: string, cost: string) {
    await owner
      .insertInto('llm_usage')
      .values({
        operator_id: operatorId,
        user_id: userId,
        route: 'expert',
        provider: 'openai',
        model: 'synthetic-model',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: cost,
        duration_ms: 1,
        outcome: 'complete',
        expert_id: expertId,
      })
      .execute();
  }

  /** 协会A：营养 3 次（成功 2、超时 1，有用 1、没用 1），心血管 1 次失败；协会B：营养 1 次成功 */
  async function seedBoth() {
    const a1 = ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA);
    const a2 = ctxOf(f.users.managerA2, 'manager', f.operatorA, f.orgA);
    const b1 = ctxOf(f.users.managerB1, 'manager', f.operatorB, f.orgB);
    const seededA = await seedCalls(a1, [
      { expertId: 'nutrition', status: 'done', tokens: [100, 50], rating: 'useful' },
      { expertId: 'cardiovascular', status: 'failed', tokens: [10, 0] },
    ]);
    await seedCalls(a2, [
      { expertId: 'nutrition', status: 'done', tokens: [200, 80], rating: 'not_useful' },
    ]);
    await seedCalls(a2, [{ expertId: 'nutrition', status: 'timeout', tokens: [30, 0] }]);
    const seededB = await seedCalls(b1, [
      { expertId: 'nutrition', status: 'done', tokens: [999, 999], rating: 'useful' },
    ]);
    await seedUsage(f.operatorA, f.users.managerA1.id, 'nutrition', '0.001500');
    await seedUsage(f.operatorA, f.users.managerA2.id, 'nutrition', '0.002500');
    await seedUsage(f.operatorB, f.users.managerB1.id, 'nutrition', '0.900000');
    return { seededA, seededB };
  }

  beforeAll(async () => {
    appDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
    server = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
  });

  afterAll(async () => {
    await server.close();
    await appDb.destroy();
    await owner.destroy();
  });

  describe('GET /api/expert-stats', () => {
    it('未登录 401；跨租户访问被拒绝：健管师、机构管理员 403', async () => {
      await request(server.getHttpServer()).get('/api/expert-stats').expect(401);
      for (const u of [
        f.users.managerA1,
        f.users.managerB1,
        f.users.orgAdminA,
        f.users.orgAdminA2,
      ]) {
        const res = await (await as(u)).get('/api/expert-stats').expect(403);
        expect(res.body).toEqual({ error: 'forbidden' });
      }
    });

    it('跨租户访问被拒绝：运营商只看到本协会，请求别的协会也只返回本协会', async () => {
      const { seededA, seededB } = await seedBoth();
      const opA = await as(f.users.operatorAdminA);
      const own = (await opA.get('/api/expert-stats').expect(200)).body;
      const asked = (
        await opA.get('/api/expert-stats').query({ operatorId: f.operatorB }).expect(200)
      ).body;
      expect(asked).toEqual(own);
      expect(own).toMatchObject({ scope: 'operator', operatorId: null, operators: [] });
      expect(own.from).toBe(daysAgo(29));
      expect(own.to).toBe(today());

      expect(own.rows).toEqual([
        {
          operatorId: null,
          operatorName: null,
          expertId: 'cardiovascular',
          expertName: expect.any(String),
          date: today(),
          calls: 1,
          succeeded: 0,
          timedOut: 0,
          successRate: 0,
          timeoutRate: 0,
          inputTokens: 10,
          outputTokens: 0,
          costUsd: 0,
          useful: 0,
          notUseful: 0,
        },
        {
          operatorId: null,
          operatorName: null,
          expertId: 'nutrition',
          expertName: expect.any(String),
          date: today(),
          calls: 3,
          succeeded: 2,
          timedOut: 1,
          successRate: 0.6667,
          timeoutRate: 0.3333,
          inputTokens: 330,
          outputTokens: 130,
          costUsd: 0.004,
          useful: 1,
          notUseful: 1,
        },
      ]);
      expect(
        own.totals.map((t: { expertId: string; calls: number }) => [t.expertId, t.calls]),
      ).toEqual([
        ['cardiovascular', 1],
        ['nutrition', 3],
      ]);

      // 不含健管师、客户、任务的 id，也不含意见内容
      const text = JSON.stringify(own);
      for (const r of own.rows) expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
      for (const secret of [
        f.users.managerA1.id,
        f.users.managerA2.id,
        f.operatorA,
        f.orgA,
        seededA.taskId,
        ...seededA.callIds,
        '合成意见',
      ]) {
        expect(text).not.toContain(secret);
      }

      const opB = (await (await as(f.users.operatorAdminB)).get('/api/expert-stats').expect(200))
        .body;
      expect(opB.rows).toHaveLength(1);
      expect(opB.rows[0]).toMatchObject({ expertId: 'nutrition', calls: 1, costUsd: 0.9 });
      expect(JSON.stringify(opB)).not.toContain(seededB.taskId);
    });

    it('平台管理员看全平台，按协会分行，可以按协会筛选', async () => {
      await seedBoth();
      const platform = await as(f.users.platform);
      const all = (await platform.get('/api/expert-stats').expect(200)).body;
      expect(all.scope).toBe('platform');
      expect(all.operators.map((o: { id: string }) => o.id)).toEqual(
        expect.arrayContaining([f.operatorA, f.operatorB]),
      );
      const nutrition = all.rows.filter((r: { expertId: string }) => r.expertId === 'nutrition');
      expect(
        nutrition.map((r: { operatorName: string; calls: number }) => [r.operatorName, r.calls]),
      ).toEqual(
        expect.arrayContaining([
          ['测试协会A', 3],
          ['测试协会B', 1],
        ]),
      );
      expect(
        all.totals.find((t: { expertId: string }) => t.expertId === 'nutrition'),
      ).toMatchObject({ calls: 4, succeeded: 3, useful: 2, notUseful: 1, costUsd: 0.904 });
      for (const r of all.rows) expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
      expect(JSON.stringify(all)).not.toContain(f.users.managerB1.id);

      const onlyB = (
        await platform.get('/api/expert-stats').query({ operatorId: f.operatorB }).expect(200)
      ).body;
      expect(onlyB.operatorId).toBe(f.operatorB);
      expect(onlyB.rows).toEqual([
        expect.objectContaining({ operatorId: f.operatorB, expertId: 'nutrition', calls: 1 }),
      ]);
    });

    it('按 UTC 日期筛选：默认最近 30 天；日期不对、倒置、超过 366 天、多余参数都 400', async () => {
      const { seededA } = await seedBoth();
      // 把 A1 的营养调用挪到 40 天前（所有者身份、关闭触发器，只为构造历史数据）
      await owner.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await trx
          .updateTable('expert_calls')
          .set({ started_at: new Date(Date.now() - 40 * 86_400_000) })
          .where('id', '=', seededA.callIds[0]!)
          .execute();
      });
      const opA = await as(f.users.operatorAdminA);
      const recent = (await opA.get('/api/expert-stats').expect(200)).body;
      expect(
        recent.totals.find((t: { expertId: string }) => t.expertId === 'nutrition').calls,
      ).toBe(2);
      const older = (
        await opA
          .get('/api/expert-stats')
          .query({ from: daysAgo(45), to: daysAgo(35) })
          .expect(200)
      ).body;
      expect(older.rows).toEqual([
        expect.objectContaining({ expertId: 'nutrition', date: daysAgo(40), calls: 1, useful: 1 }),
      ]);

      for (const query of [
        { from: '2026-02-30' },
        { from: '2026/10/01' },
        { from: today(), to: daysAgo(1) },
        { from: daysAgo(400), to: today() },
        { managerId: f.users.managerA1.id },
      ]) {
        await opA.get('/api/expert-stats').query(query).expect(400);
      }
      await (
        await as(f.users.platform)
      )
        .get('/api/expert-stats')
        .query({ operatorId: 'not-a-uuid' })
        .expect(400);
    });
  });

  describe('统计函数（数据库层）', () => {
    const call = (c: TenantContext | null, operatorId: string | null = null) => {
      const q = sql`select * from expert_usage_stats(${daysAgo(1)}::date, ${today()}::date, ${operatorId}::uuid)`;
      return c ? withTenant(appDb, c, (trx) => q.execute(trx)) : q.execute(appDb);
    };

    it('跨租户访问被拒绝：没有上下文、健管师、机构管理员直接报错；运营商传别的协会仍只得到本协会', async () => {
      await seedBoth();
      await expect(call(null)).rejects.toThrow(/not allowed/);
      await expect(call(ctxOf(f.users.managerA1, 'manager', f.operatorA, f.orgA))).rejects.toThrow(
        /not allowed/,
      );
      await expect(
        call(ctxOf(f.users.orgAdminA, 'org_admin', f.operatorA, f.orgA)),
      ).rejects.toThrow(/not allowed/);

      const { rows } = await call(
        ctxOf(f.users.operatorAdminA, 'operator_admin', f.operatorA, null),
        f.operatorB,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows as Record<string, unknown>[]) {
        expect(r.operator_id).toBe(f.operatorA);
        for (const key of ['manager_id', 'client_id', 'task_id', 'consultation_id', 'opinion']) {
          expect(r).not.toHaveProperty(key);
        }
      }
      const platformRows = await call(ctxOf(f.users.platform, 'platform_admin', null, null));
      expect(
        new Set((platformRows.rows as { operator_id: string }[]).map((r) => r.operator_id)),
      ).toEqual(new Set([f.operatorA, f.operatorB]));
    });

    it('运营商和平台管理员仍然读不到专家明细表（没有为统计开策略）', async () => {
      await seedBoth();
      for (const c of [
        ctxOf(f.users.operatorAdminA, 'operator_admin', f.operatorA, null),
        ctxOf(f.users.platform, 'platform_admin', null, null),
      ]) {
        for (const table of ['expert_calls', 'expert_feedback', 'expert_consultations'] as const) {
          const rows = await withTenant(appDb, c, (trx) =>
            trx.selectFrom(table).select('id').execute(),
          );
          expect(rows, `${c.role} ${table}`).toEqual([]);
        }
      }
    });
  });

  describe('GET /api/admin/experts', () => {
    it('跨租户访问被拒绝：运营商、机构管理员、健管师 403', async () => {
      for (const u of [
        f.users.operatorAdminA,
        f.users.operatorAdminB,
        f.users.orgAdminA,
        f.users.managerA1,
      ]) {
        await (await as(u)).get('/api/admin/experts').expect(403);
      }
      await request(server.getHttpServer()).get('/api/admin/experts').expect(401);
    });

    it('平台管理员看到每位专家的版本、来源指纹、评测用例条数、上下架和有用/没用汇总', async () => {
      await seedBoth();
      const platform = await as(f.users.platform);
      await platform
        .patch('/api/admin/experts/cardiovascular/availability')
        .send({ enabled: false })
        .expect(204);
      const body = (await platform.get('/api/admin/experts').expect(200)).body;
      expect(body.from).toBe(daysAgo(29));
      expect(body.experts).toHaveLength(6);
      const nutrition = body.experts.find((e: { id: string }) => e.id === 'nutrition');
      expect(nutrition).toMatchObject({
        status: 'review',
        sourcesPending: true,
        statusAllowed: false,
        enabled: true,
        updatedAt: null,
        evalTarget: 15,
        calls: 4,
        useful: 2,
        notUseful: 1,
      });
      expect(nutrition.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(nutrition.sourcesVersion).toMatch(/^[0-9a-f]{12}$/);
      expect(nutrition.evalCases).toBeGreaterThan(0);
      const cardio = body.experts.find((e: { id: string }) => e.id === 'cardiovascular');
      expect(cardio).toMatchObject({ enabled: false, calls: 1, useful: 0 });
      expect(cardio.updatedAt).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain(f.users.platform.id);
    });
  });

  describe('GET /api/admin/experts/:id/availability-events', () => {
    it('暂停和恢复各记一条，新的在前；只给操作人 id', async () => {
      const platform = await as(f.users.platform);
      for (const enabled of [false, false, true]) {
        await platform
          .patch('/api/admin/experts/nutrition/availability')
          .send({ enabled })
          .expect(204);
      }
      const { events } = (
        await platform.get('/api/admin/experts/nutrition/availability-events').expect(200)
      ).body;
      expect(events.map((e: { action: string }) => e.action)).toEqual(['resumed', 'paused']);
      for (const e of events) {
        expect(Object.keys(e).sort()).toEqual(['action', 'actorId', 'createdAt', 'expertId', 'id']);
        expect(e).toMatchObject({ expertId: 'nutrition', actorId: f.users.platform.id });
      }
      expect(
        (await platform.get('/api/admin/experts/cardiovascular/availability-events').expect(200))
          .body.events,
      ).toEqual([]);
      await platform.get('/api/admin/experts/no-such-expert/availability-events').expect(404);
      await platform.get('/api/admin/experts/NOT_AN_ID/availability-events').expect(404);
    });

    it('跨租户访问被拒绝：运营商、机构管理员、健管师 403', async () => {
      const platform = await as(f.users.platform);
      await platform
        .patch('/api/admin/experts/nutrition/availability')
        .send({ enabled: false })
        .expect(204);
      for (const u of [
        f.users.operatorAdminA,
        f.users.orgAdminA,
        f.users.managerA1,
        f.users.managerB1,
      ]) {
        await (await as(u)).get('/api/admin/experts/nutrition/availability-events').expect(403);
      }
    });

    it('暂停记录只能由数据库触发器写：应用账号（平台管理员上下文）不能插入、修改、删除', async () => {
      const platform = await as(f.users.platform);
      await platform
        .patch('/api/admin/experts/nutrition/availability')
        .send({ enabled: false })
        .expect(204);
      const ctx = ctxOf(f.users.platform, 'platform_admin', null, null);
      await expect(
        withTenant(appDb, ctx, (trx) =>
          trx
            .insertInto('expert_availability_events')
            .values({ expert_id: 'nutrition', actor_id: f.users.platform.id, action: 'resumed' })
            .execute(),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(appDb, ctx, (trx) =>
          trx.updateTable('expert_availability_events').set({ action: 'resumed' }).execute(),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(appDb, ctx, (trx) => trx.deleteFrom('expert_availability_events').execute()),
      ).rejects.toThrow(/permission denied/);
      const events = await owner
        .selectFrom('expert_availability_events')
        .select('action')
        .execute();
      expect(events).toEqual([{ action: 'paused' }]);
    });
  });
});
