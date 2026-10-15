import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  withTenant,
  type Db,
  type TenantContext,
  type TenantTransaction,
} from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * M1 工作台数据表的数据库层隔离和约束测试（规格第五节、验收标准 11）。
 * 以应用角色 hb_app 直接连接，绕过仓储层。
 */
describe('工作台数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const WORK_TABLES = [
    'tasks',
    'task_messages',
    'task_steps',
    'task_plans',
    'artifacts',
    'artifact_events',
  ] as const;

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA);

  const scopeA1 = () => ({
    operator_id: f.operatorA,
    org_id: f.orgA,
    manager_id: f.users.managerA1.id,
  });
  const content = (text = '近况') => JSON.stringify({ professional: text, clientFacing: text });

  /** 以健管师 A1 的身份建一整套任务数据，返回各行 id */
  async function seedWork(clientId: string | null = null) {
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
          role: 'manager',
          mode: 'craft',
          content: '写个近况小结',
          client_refs: clientId ? [clientId] : [],
          status: 'complete',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('task_steps')
        .values({
          ...scopeA1(),
          message_id: message.id,
          seq: 0,
          kind: 'read_client',
          label_key: 'steps.readClient',
          status: 'done',
        })
        .execute();
      await trx
        .insertInto('task_plans')
        .values({
          ...scopeA1(),
          message_id: message.id,
          steps: JSON.stringify([{ kind: 'read_client' }]),
          status: 'proposed',
        })
        .execute();
      const artifactId = crypto.randomUUID();
      await trx
        .insertInto('artifacts')
        .values({
          ...scopeA1(),
          id: artifactId,
          task_id: task.id,
          client_id: clientId,
          skill_id: 'client-recent-summary',
          kind: 'summary',
          lineage_id: artifactId,
          version: 1,
          status: 'draft',
          content: content(),
        })
        .execute();
      await trx
        .insertInto('artifact_events')
        .values({
          ...scopeA1(),
          artifact_id: artifactId,
          actor_id: f.users.managerA1.id,
          action: 'created',
        })
        .execute();
      return { taskId: task.id, messageId: message.id, artifactId };
    });
  }

  const asA1 = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, managerA1(), fn);

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

  it('没有租户上下文时，新表一行都查不到', async () => {
    await seedWork(f.clients.a1[0]);
    for (const table of [
      ...WORK_TABLES,
      'critical_thresholds',
      'critical_threshold_events',
    ] as const) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('只有健管师本人能看到自己的任务、消息、步骤、计划、产物和记录', async () => {
    await seedWork(f.clients.a1[0]);
    const mine = await asA1(async (trx) => {
      const counts: Record<string, number> = {};
      for (const t of WORK_TABLES)
        counts[t] = (
          await trx
            .selectFrom(t)
            .select(sql`1`.as('x'))
            .execute()
        ).length;
      return counts;
    });
    expect(Object.values(mine).every((n) => n === 1)).toBe(true);

    const others = [
      managerA2(),
      ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB),
      ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA),
      ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null),
      ctx(f.users.platform.id, 'platform_admin', null, null),
    ];
    for (const other of others) {
      for (const t of WORK_TABLES) {
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

  it('别人改不了、也作废不了健管师的任务和产物', async () => {
    const { taskId, artifactId } = await seedWork();
    await withTenant(app, managerA2(), async (trx) => {
      const t = await trx
        .updateTable('tasks')
        .set({ title: 'x' })
        .where('id', '=', taskId)
        .execute();
      const a = await trx
        .updateTable('artifacts')
        .set({ status: 'approved' })
        .where('id', '=', artifactId)
        .execute();
      expect(Number(t[0]?.numUpdatedRows)).toBe(0);
      expect(Number(a[0]?.numUpdatedRows)).toBe(0);
    });
  });

  it('不能以别人或别的协会的名义写入', async () => {
    const attempts = [
      { ...scopeA1(), manager_id: f.users.managerA2.id },
      { ...scopeA1(), operator_id: f.operatorB },
      { ...scopeA1(), org_id: f.orgA2 },
    ];
    for (const values of attempts) {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('tasks')
            .values({ ...values, title: 'x' })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('任务只能关联自己的客户', async () => {
    for (const clientId of [f.clients.a2, f.clients.b1]) {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('tasks')
            .values({ ...scopeA1(), client_id: clientId, title: 'x' })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    }
  });

  it('任务关联客户后不能换成别的客户，也不能自己设成只读', async () => {
    const { taskId } = await seedWork(f.clients.a1[0]);
    await expect(
      asA1((trx) =>
        trx
          .updateTable('tasks')
          .set({ client_id: f.clients.a1[1] })
          .where('id', '=', taskId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asA1((trx) =>
        trx
          .updateTable('tasks')
          .set({ detached_reason: 'client_deleted', archived_at: new Date() })
          .where('id', '=', taskId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('子表不能挂到别人的任务、消息或产物上', async () => {
    const { taskId, messageId, artifactId } = await seedWork();
    const a2Scope = { operator_id: f.operatorA, org_id: f.orgA, manager_id: f.users.managerA2.id };
    await withTenant(app, managerA2(), async (trx) => {
      await expect(
        trx
          .insertInto('task_messages')
          .values({ ...a2Scope, task_id: taskId, role: 'manager', mode: 'ask', status: 'complete' })
          .execute(),
      ).rejects.toMatchObject({ code: '23503' });
    });
    await withTenant(app, managerA2(), async (trx) => {
      await expect(
        trx
          .insertInto('task_steps')
          .values({
            ...a2Scope,
            message_id: messageId,
            seq: 1,
            kind: 'answer',
            label_key: 'steps.answer',
            status: 'done',
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23503' });
    });
    await withTenant(app, managerA2(), async (trx) => {
      await expect(
        trx
          .insertInto('artifact_events')
          .values({
            ...a2Scope,
            artifact_id: artifactId,
            actor_id: f.users.managerA2.id,
            action: 'created',
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('产物状态', () => {
    it('只能以草稿插入', async () => {
      const { taskId } = await seedWork();
      const id = crypto.randomUUID();
      await expect(
        asA1((trx) =>
          trx
            .insertInto('artifacts')
            .values({
              ...scopeA1(),
              id,
              task_id: taskId,
              client_id: null,
              skill_id: 'client-recent-summary',
              kind: 'summary',
              lineage_id: id,
              version: 1,
              status: 'approved',
              content: content(),
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('草稿可以修改和确认，确认后任何一列都不能再改', async () => {
      const { artifactId } = await seedWork();
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ content: content('改过') })
          .where('id', '=', artifactId)
          .execute(),
      );
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', artifactId)
          .execute(),
      );
      const changes = [
        { status: 'draft' as const },
        { content: content('再改') },
        { kind: 'other' },
        { critical_flags: '[]' },
        { client_id: null },
      ];
      for (const set of changes) {
        await expect(
          asA1((trx) =>
            trx.updateTable('artifacts').set(set).where('id', '=', artifactId).execute(),
          ),
          JSON.stringify(set),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('已退回的产物不能再确认', async () => {
      const { artifactId } = await seedWork();
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'returned' })
          .where('id', '=', artifactId)
          .execute(),
      );
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifacts')
            .set({ status: 'approved' })
            .where('id', '=', artifactId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('健管师不能自己作废草稿，也不能同时改内容和状态', async () => {
      const { artifactId } = await seedWork();
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifacts')
            .set({ status: 'voided' })
            .where('id', '=', artifactId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifacts')
            .set({ status: 'approved', content: content('偷偷改') })
            .where('id', '=', artifactId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('产物的客户必须和任务一致，新版本只能接在同一任务、同一产物链上', async () => {
      const { taskId, artifactId } = await seedWork(f.clients.a1[0]);
      const other = await seedWork(f.clients.a1[1]);
      const insert = (values: Record<string, unknown>) => {
        const id = crypto.randomUUID();
        return asA1((trx) =>
          trx
            .insertInto('artifacts')
            .values({
              ...scopeA1(),
              id,
              task_id: taskId,
              client_id: f.clients.a1[0],
              skill_id: 'client-recent-summary',
              kind: 'summary',
              lineage_id: id,
              version: 1,
              status: 'draft',
              content: content(),
              ...values,
            })
            .execute(),
        );
      };
      // 客户和任务不一致
      await expect(insert({ client_id: f.clients.a1[1] })).rejects.toMatchObject({ code: '23514' });
      // 任务有客户时，产物不能不带客户
      await expect(insert({ client_id: null })).rejects.toMatchObject({ code: '23514' });
      // 上一版是别的任务的产物
      await expect(
        insert({ version: 2, parent_id: other.artifactId, lineage_id: other.artifactId }),
      ).rejects.toMatchObject({ code: '23503' });
      // 换了产物链
      await expect(
        insert({ version: 2, parent_id: artifactId, lineage_id: other.artifactId }),
      ).rejects.toMatchObject({ code: '23514' });
      // 正常的新版本
      await expect(
        insert({ version: 2, parent_id: artifactId, lineage_id: artifactId }),
      ).resolves.toBeDefined();
    });

    it('产物记录只能追加，任务不能删除', async () => {
      const { artifactId } = await seedWork();
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifact_events')
            .set({ reason: 'x' })
            .where('artifact_id', '=', artifactId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) =>
          trx.deleteFrom('artifact_events').where('artifact_id', '=', artifactId).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(asA1((trx) => trx.deleteFrom('tasks').execute())).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('健管师调机构后，工作数据的 org_id 跟着变，确认过的产物也一样', async () => {
    const { artifactId } = await seedWork(f.clients.a1[0]);
    await asA1((trx) =>
      trx
        .updateTable('artifacts')
        .set({ status: 'approved' })
        .where('id', '=', artifactId)
        .execute(),
    );
    await owner
      .updateTable('users')
      .set({ org_id: f.orgA2 })
      .where('id', '=', f.users.managerA1.id)
      .execute();
    for (const t of WORK_TABLES) {
      const rows = await owner
        .selectFrom(t)
        .select('org_id')
        .where('manager_id', '=', f.users.managerA1.id)
        .execute();
      expect(rows.length, t).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.org_id === f.orgA2),
        t,
      ).toBe(true);
    }
  });

  describe('客户转出或删除（Q11）', () => {
    async function approvedAndDraft() {
      const work = await seedWork(f.clients.a1[0]);
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', work.artifactId)
          .execute(),
      );
      const draftId = crypto.randomUUID();
      await asA1((trx) =>
        trx
          .insertInto('artifacts')
          .values({
            ...scopeA1(),
            id: draftId,
            task_id: work.taskId,
            client_id: f.clients.a1[0],
            skill_id: 'client-recent-summary',
            kind: 'summary',
            lineage_id: work.artifactId,
            version: 2,
            parent_id: work.artifactId,
            status: 'draft',
            content: content(),
          })
          .execute(),
      );
      return { ...work, draftId };
    }

    it('转给别的健管师：任务归档只读，草稿作废，新健管师看不到', async () => {
      const { taskId, artifactId, draftId } = await approvedAndDraft();
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();

      const task = await asA1((trx) =>
        trx.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow(),
      );
      expect(task.client_id).toBeNull();
      expect(task.detached_reason).toBe('client_transferred');
      expect(task.archived_at).not.toBeNull();

      const artifacts = await asA1((trx) =>
        trx.selectFrom('artifacts').select(['id', 'status', 'client_id']).execute(),
      );
      expect(artifacts.find((a) => a.id === artifactId)).toMatchObject({
        status: 'approved',
        client_id: null,
      });
      expect(artifacts.find((a) => a.id === draftId)).toMatchObject({
        status: 'voided',
        client_id: null,
      });

      const voidEvents = await asA1((trx) =>
        trx.selectFrom('artifact_events').selectAll().where('action', '=', 'voided').execute(),
      );
      expect(voidEvents).toHaveLength(1);
      expect(voidEvents[0]?.actor_id).toBeNull();

      // 只读：不能改名、取消归档、确认作废的草稿
      await expect(
        asA1((trx) =>
          trx.updateTable('tasks').set({ archived_at: null }).where('id', '=', taskId).execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifacts')
            .set({ status: 'approved' })
            .where('id', '=', draftId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      for (const t of WORK_TABLES) {
        const rows = await withTenant(app, managerA2(), (trx) =>
          trx
            .selectFrom(t)
            .select(sql`1`.as('x'))
            .execute(),
        );
        expect(rows, t).toHaveLength(0);
      }
    });

    it('客户被删除：任务和产物保留，但与客户断开', async () => {
      const { taskId, artifactId, draftId } = await approvedAndDraft();
      await asA1((trx) => trx.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute());

      const task = await asA1((trx) =>
        trx.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow(),
      );
      expect(task).toMatchObject({ client_id: null, detached_reason: 'client_deleted' });
      const artifacts = await asA1((trx) =>
        trx.selectFrom('artifacts').select(['id', 'status', 'client_id']).execute(),
      );
      expect(artifacts.find((a) => a.id === artifactId)?.status).toBe('approved');
      expect(artifacts.find((a) => a.id === draftId)?.status).toBe('voided');
      expect(artifacts.every((a) => a.client_id === null)).toBe(true);
    });

    it('应用角色不能直接调用断开函数', async () => {
      await expect(
        asA1((trx) =>
          sql`select detach_client_work(${f.clients.a1[0]}::uuid, 'client_deleted')`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('只读任务和产物记录（审查补充）', () => {
    /** 把客户 a1[0] 转给 A2，让 A1 的相关任务变成只读 */
    const transfer = () =>
      owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();

    it('任务关联客户之前生成的草稿，客户转出后同样作废', async () => {
      const { taskId, artifactId } = await seedWork(null);
      await asA1((trx) =>
        trx
          .updateTable('tasks')
          .set({ client_id: f.clients.a1[0] })
          .where('id', '=', taskId)
          .execute(),
      );
      await transfer();
      const row = await asA1((trx) =>
        trx
          .selectFrom('artifacts')
          .select('status')
          .where('id', '=', artifactId)
          .executeTakeFirstOrThrow(),
      );
      expect(row.status).toBe('voided');
    });

    it('只读任务上不能再发消息、写步骤、生成或确认产物，也不能改写历史消息', async () => {
      const { taskId, messageId } = await seedWork(f.clients.a1[0]);
      await transfer();
      const attempts: ((trx: TenantTransaction) => Promise<unknown>)[] = [
        (trx: TenantTransaction) =>
          trx
            .insertInto('task_messages')
            .values({
              ...scopeA1(),
              task_id: taskId,
              role: 'manager',
              mode: 'ask',
              status: 'complete',
            })
            .execute(),
        (trx: TenantTransaction) =>
          trx
            .insertInto('task_steps')
            .values({
              ...scopeA1(),
              message_id: messageId,
              seq: 5,
              kind: 'answer',
              label_key: 'steps.answer',
              status: 'done',
            })
            .execute(),
        (trx: TenantTransaction) =>
          trx
            .updateTable('task_messages')
            .set({ content: '改写' })
            .where('id', '=', messageId)
            .execute(),
        (trx: TenantTransaction) => {
          const id = crypto.randomUUID();
          return trx
            .insertInto('artifacts')
            .values({
              ...scopeA1(),
              id,
              task_id: taskId,
              client_id: null,
              skill_id: 'client-recent-summary',
              kind: 'summary',
              lineage_id: id,
              version: 1,
              status: 'draft',
              content: content(),
            })
            .execute();
        },
      ];
      for (const [i, attempt] of attempts.entries()) {
        await expect(asA1(attempt), `attempt ${i}`).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('消息不能改任务、角色和引用的客户', async () => {
      const { messageId } = await seedWork(f.clients.a1[0]);
      for (const set of [
        { role: 'assistant' as const },
        { client_refs: [] as string[] },
        { mode: 'ask' as const },
      ]) {
        await expect(
          asA1((trx) =>
            trx.updateTable('task_messages').set(set).where('id', '=', messageId).execute(),
          ),
          JSON.stringify(set),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('消息只能引用任务关联的那位客户', async () => {
      const { taskId } = await seedWork(f.clients.a1[0]);
      for (const ref of [f.clients.a1[1], f.clients.b1]) {
        await expect(
          asA1((trx) =>
            trx
              .insertInto('task_messages')
              .values({
                ...scopeA1(),
                task_id: taskId,
                role: 'manager',
                mode: 'ask',
                client_refs: [ref],
                status: 'complete',
              })
              .execute(),
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      const noClient = await seedWork(null);
      await expect(
        asA1((trx) =>
          trx
            .insertInto('task_messages')
            .values({
              ...scopeA1(),
              task_id: noClient.taskId,
              role: 'manager',
              mode: 'ask',
              client_refs: [f.clients.a1[0]],
              status: 'complete',
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('客户转出后，原消息里不再保留对这位客户的引用', async () => {
      const { messageId } = await seedWork(f.clients.a1[0]);
      await transfer();
      const msg = await asA1((trx) =>
        trx
          .selectFrom('task_messages')
          .select('client_refs')
          .where('id', '=', messageId)
          .executeTakeFirstOrThrow(),
      );
      expect(msg.client_refs).toEqual([]);
    });

    it('产物记录不能冒用别人、冒充系统，复制和导出只针对已审核产物', async () => {
      const { artifactId } = await seedWork();
      const event = (values: Record<string, unknown>) =>
        asA1((trx) =>
          trx
            .insertInto('artifact_events')
            .values({
              ...scopeA1(),
              artifact_id: artifactId,
              actor_id: f.users.managerA1.id,
              action: 'copied',
              ...values,
            })
            .execute(),
        );
      await expect(event({ actor_id: f.users.managerB1.id })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(event({ actor_id: null, action: 'voided' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(event({ action: 'voided' })).rejects.toMatchObject({ code: '23514' });
      // 草稿不能记复制、导出和确认
      await expect(event({})).rejects.toMatchObject({ code: '23514' });
      await expect(event({ action: 'exported', format: 'pdf' })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(event({ action: 'approved' })).rejects.toMatchObject({ code: '23514' });

      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', artifactId)
          .execute(),
      );
      await expect(event({ action: 'exported', format: 'png' })).resolves.toBeDefined();
    });

    it('客户转出后，已审核产物不能再记复制或导出', async () => {
      const { artifactId } = await seedWork(f.clients.a1[0]);
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', artifactId)
          .execute(),
      );
      await transfer();
      await expect(
        asA1((trx) =>
          trx
            .insertInto('artifact_events')
            .values({
              ...scopeA1(),
              artifact_id: artifactId,
              actor_id: f.users.managerA1.id,
              action: 'copied',
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('llm_usage 没有任务和客户的列', async () => {
    const { rows } = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'llm_usage'
    `.execute(owner);
    const cols = rows.map((r) => r.column_name);
    expect(cols).not.toContain('task_id');
    expect(cols).not.toContain('client_id');
  });
});
