import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Db, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { ExpertQuotaExceeded, ExpertsRepository } from '../src/experts/experts.repository.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

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

/**
 * M3 专家数据表的数据库层隔离和约束测试（规格 6.1、6.2）。以应用角色 hb_app 直接连接，绕过仓储层。
 */
describe('专家数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const DETAIL_TABLES = ['expert_consultations', 'expert_calls', 'expert_feedback'] as const;

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);
  const scopeA1 = () => ({
    operator_id: f.operatorA,
    org_id: f.orgA,
    manager_id: f.users.managerA1.id,
  });

  /** 以健管师 A1 的身份建一个任务、一条消息和一次已完成的专家调用（含一条反馈） */
  async function seedConsultation(clientId: string | null = null) {
    return withTenant(app, managerA1(), async (trx) => {
      const task = await trx
        .insertInto('tasks')
        .values({ ...scopeA1(), client_id: clientId, title: '测试任务' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const message = await trx
        .insertInto('task_messages')
        .values({
          ...scopeA1(),
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
          ...scopeA1(),
          task_id: task.id,
          message_id: message.id,
          client_id: clientId,
          trigger: 'mention',
          routing: ROUTING,
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const call = await trx
        .insertInto('expert_calls')
        .values({
          ...scopeA1(),
          consultation_id: consultation.id,
          expert_id: 'nutrition',
          expert_version: '0.1.0',
          sources_version: '0123456789ab',
          selected_reason: 'manager',
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('expert_calls')
        .set({ status: 'done', opinion: OPINION })
        .where('id', '=', call.id)
        .execute();
      await trx
        .updateTable('expert_consultations')
        .set({ status: 'done', synthesis_status: 'skipped' })
        .where('id', '=', consultation.id)
        .execute();
      await trx
        .insertInto('expert_feedback')
        .values({ ...scopeA1(), expert_call_id: call.id, rating: 'useful' })
        .execute();
      return {
        taskId: task.id,
        messageId: message.id,
        consultationId: consultation.id,
        callId: call.id,
      };
    });
  }

  beforeAll(async () => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  it('没有租户上下文时，专家明细表一行都查不到', async () => {
    await seedConsultation();
    for (const table of [...DETAIL_TABLES, 'expert_availability_events'] as const) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('跨租户访问被拒绝：专家调用、意见和反馈只有健管师本人能看到', async () => {
    await seedConsultation(f.clients.a1[0]);
    const mine = await withTenant(app, managerA1(), async (trx) => {
      const counts: number[] = [];
      for (const t of DETAIL_TABLES)
        counts.push(
          (
            await trx
              .selectFrom(t)
              .select(sql`1`.as('x'))
              .execute()
          ).length,
        );
      return counts;
    });
    expect(mine).toEqual([1, 1, 1]);
    const others = [
      managerA2(),
      ctx(f.users.managerA3.id, 'manager', f.operatorA, f.orgA2),
      ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB),
      ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA),
      ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null),
      platform(),
    ];
    for (const other of others) {
      for (const t of DETAIL_TABLES) {
        const rows = await withTenant(app, other, (trx) =>
          trx
            .selectFrom(t)
            .select(sql`1`.as('x'))
            .execute(),
        );
        expect(rows, `${other.role} ${t}`).toHaveLength(0);
      }
    }
  });

  it('不能用别人的租户字段写入，也不能往别人的调用里加专家或反馈', async () => {
    const { taskId, messageId, consultationId, callId } = await seedConsultation();
    await expect(
      withTenant(app, managerA2(), (trx) =>
        trx
          .insertInto('expert_consultations')
          .values({
            ...scopeA1(),
            task_id: taskId,
            message_id: messageId,
            trigger: 'mention',
            routing: ROUTING,
            status: 'running',
          })
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(app, managerA2(), (trx) =>
        trx
          .insertInto('expert_feedback')
          .values({
            operator_id: f.operatorA,
            org_id: f.orgA,
            manager_id: f.users.managerA2.id,
            expert_call_id: callId,
            rating: 'useful',
          })
          .execute(),
      ),
    ).rejects.toThrow();
    const updated = await withTenant(app, managerA2(), (trx) =>
      trx
        .updateTable('expert_consultations')
        .set({ status: 'stopped' })
        .where('id', '=', consultationId)
        .execute(),
    );
    expect(Number(updated[0]?.numUpdatedRows)).toBe(0);
  });

  it('结束后的调用和意见不能再改；路由结果不能改', async () => {
    const { consultationId, callId } = await seedConsultation();
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .updateTable('expert_calls')
          .set({ opinion: JSON.stringify({ inScope: false }) })
          .where('id', '=', callId)
          .execute(),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .updateTable('expert_consultations')
          .set({ status: 'failed' })
          .where('id', '=', consultationId)
          .execute(),
      ),
    ).rejects.toThrow(/immutable/);
    // routing 列没有授予更新权限
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .updateTable('expert_consultations')
          .set({ routing: ROUTING })
          .where('id', '=', consultationId)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx.deleteFrom('expert_calls').where('id', '=', callId).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('产物只能引用同一任务的专家调用，引用后不能改', async () => {
    const first = await seedConsultation();
    const second = await seedConsultation();
    const artifact = (consultationId: string) =>
      withTenant(app, managerA1(), async (trx) => {
        const id = crypto.randomUUID();
        await trx
          .insertInto('artifacts')
          .values({
            ...scopeA1(),
            id,
            task_id: first.taskId,
            client_id: null,
            skill_id: 'report-interpretation',
            kind: 'report_interpretation',
            lineage_id: id,
            version: 1,
            status: 'draft',
            content: JSON.stringify({ professional: 'x', clientFacing: 'x' }),
            consultation_id: consultationId,
          })
          .execute();
        return id;
      });
    await expect(artifact(second.consultationId)).rejects.toThrow();
    const id = await artifact(first.consultationId);
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .updateTable('artifacts')
          // 类型上就不允许改（db/types.ts 里是只读列），这里绕过类型检查直接试数据库
          .set({ consultation_id: null } as never)
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('任务只读（客户转出）后不能再发起专家调用，也不能反馈', async () => {
    const { taskId, messageId, callId } = await seedConsultation(f.clients.a1[0]);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    // 转出后任务和调用都对 A1 仍然可见，但只读
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .insertInto('expert_consultations')
          .values({
            ...scopeA1(),
            task_id: taskId,
            message_id: messageId,
            trigger: 'mention',
            routing: ROUTING,
            status: 'running',
          })
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      withTenant(app, managerA1(), (trx) =>
        trx
          .updateTable('expert_feedback')
          .set({ rating: 'not_useful', reason: 'other' })
          .where('expert_call_id', '=', callId)
          .execute(),
      ),
    ).rejects.toThrow(/read-only/);
  });

  it('只有平台管理员能暂停专家；暂停记录由数据库写入，只有平台管理员能看，不能改删', async () => {
    const write = (c: TenantContext, enabled: boolean) =>
      withTenant(app, c, (trx) =>
        trx
          .insertInto('expert_availability')
          .values({ expert_id: 'nutrition', enabled, updated_by: c.userId })
          .onConflict((oc) => oc.column('expert_id').doUpdateSet({ enabled, updated_by: c.userId }))
          .execute(),
      );
    for (const c of [
      managerA1(),
      ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA),
      ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null),
    ]) {
      await expect(write(c, false), c.role).rejects.toThrow();
    }
    await write(platform(), false);
    await write(platform(), false);
    await write(platform(), true);

    // 任何登录账号都能读到暂停状态
    const seen = await withTenant(app, managerA1(), (trx) =>
      trx.selectFrom('expert_availability').select(['expert_id', 'enabled']).execute(),
    );
    expect(seen).toEqual([{ expert_id: 'nutrition', enabled: true }]);
    // 记录：状态没变的那次不记
    const events = await withTenant(app, platform(), (trx) =>
      trx.selectFrom('expert_availability_events').select(['action', 'actor_id']).execute(),
    );
    expect(events.map((e) => e.action)).toEqual(['paused', 'resumed']);
    expect(events.every((e) => e.actor_id === f.users.platform.id)).toBe(true);
    expect(
      await withTenant(app, managerA1(), (trx) =>
        trx.selectFrom('expert_availability_events').selectAll().execute(),
      ),
    ).toEqual([]);
    await expect(
      withTenant(app, platform(), (trx) =>
        trx
          .insertInto('expert_availability_events')
          .values({ expert_id: 'nutrition', actor_id: f.users.platform.id, action: 'paused' })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, platform(), (trx) => trx.deleteFrom('expert_availability_events').execute()),
    ).rejects.toThrow(/permission denied/);
  });
  /** 用所有者身份给健管师 A2 建一次专家调用（A2 自己的任务） */
  async function seedForA2() {
    const scope = { operator_id: f.operatorA, org_id: f.orgA, manager_id: f.users.managerA2.id };
    const task = await owner
      .insertInto('tasks')
      .values({ ...scope, title: '测试任务' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const message = await owner
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
    const c = await owner
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
    return c.id as string;
  }

  it('跨租户访问被拒绝：退回重写不能复用别人的专家调用', async () => {
    const mine = await seedConsultation();
    const theirs = await seedForA2();
    // 产物只能引用同一任务的调用：A1 的产物引用 A2 的调用被外键拒绝
    await expect(
      withTenant(app, managerA1(), async (trx) => {
        const id = crypto.randomUUID();
        await trx
          .insertInto('artifacts')
          .values({
            ...scopeA1(),
            id,
            task_id: mine.taskId,
            client_id: null,
            skill_id: 'report-interpretation',
            kind: 'report_interpretation',
            lineage_id: id,
            version: 1,
            status: 'draft',
            content: JSON.stringify({ professional: 'x', clientFacing: 'x' }),
            consultation_id: theirs,
          })
          .execute();
      }),
    ).rejects.toThrow();
    // 复用时按 id 读调用：别人的读不到
    const repo = new ExpertsRepository(app);
    expect(await repo.get(managerA1(), theirs)).toBeUndefined();
    expect(await repo.get(managerA1(), mine.consultationId)).toBeDefined();
  });

  it('每日上限：并发请求在配额锁下重新计数，不会一起越过上限', async () => {
    const { taskId, messageId } = await seedConsultation();
    const repo = new ExpertsRepository(app);
    const call = {
      expertId: 'cardiovascular',
      version: '0.1.0',
      sourcesVersion: '0123456789ab',
      selectedReason: 'manager' as const,
    };
    const create = () =>
      repo.createConsultation(
        managerA1(),
        {
          taskId,
          messageId,
          clientId: null,
          reportId: null,
          trigger: 'mention',
          routing: { selected: [], excluded: [], overCap: [], ruleOnly: false },
        },
        [call],
        // seedConsultation 已经有 1 次，上限 2 时只能再成功 1 次
        2,
      );
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ExpertQuotaExceeded);
    // 别的健管师的调用不占本人的配额
    const a2 = await seedForA2();
    expect(a2).toBeTruthy();
    expect(await repo.callsToday(managerA1())).toBe(2);
    expect(await repo.callsToday(managerA2())).toBe(0);
  });

  it('运营商读不到带专家 id 的计量行；平台管理员和本人照旧', async () => {
    const row = (expertId: string | null) => ({
      operator_id: f.operatorA,
      user_id: f.users.managerA1.id,
      route: expertId ? 'expert' : 'chat',
      provider: 'openai',
      model: 'm',
      input_tokens: 1,
      output_tokens: 1,
      duration_ms: 1,
      outcome: 'complete',
      expert_id: expertId,
    });
    await owner
      .insertInto('llm_usage')
      .values([row('nutrition'), row(null)])
      .execute();
    const read = (c: TenantContext) =>
      withTenant(app, c, (trx) => trx.selectFrom('llm_usage').select('route').execute());
    expect(await read(ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null))).toEqual(
      [{ route: 'chat' }],
    );
    expect(await read(platform())).toHaveLength(2);
    expect(await read(managerA1())).toHaveLength(2);
    expect(await read(managerA2())).toEqual([]);
  });

  it('暂停状态谁都能读，但读不到是谁暂停的', async () => {
    await withTenant(app, platform(), (trx) =>
      trx
        .insertInto('expert_availability')
        .values({ expert_id: 'nutrition', enabled: false, updated_by: f.users.platform.id })
        .execute(),
    );
    for (const c of [managerA1(), platform()]) {
      await expect(
        withTenant(app, c, (trx) =>
          trx.selectFrom('expert_availability').select('updated_by').execute(),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
