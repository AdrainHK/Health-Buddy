import { DEFAULT_CRITICAL_RULES } from '@health-buddy/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Db, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/** 危急指标阈值表的数据库层隔离测试（规格第五节之二）。 */
describe('危急指标阈值的行级安全', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const opAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const opAdminB = () => ctx(f.users.operatorAdminB.id, 'operator_admin', f.operatorB, null);
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const orgAdminA = () => ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);

  beforeAll(() => {
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

  const thresholdsOf = (c: TenantContext) =>
    withTenant(app, c, (trx) => trx.selectFrom('critical_thresholds').selectAll().execute());

  it('每个协会创建时都复制了一份默认阈值', async () => {
    const rows = await owner
      .selectFrom('critical_thresholds')
      .select(['operator_id'])
      .where('operator_id', '=', f.operatorA)
      .execute();
    expect(rows).toHaveLength(DEFAULT_CRITICAL_RULES.length);
  });

  it('本协会的协会管理员、机构管理员和健管师能读本协会的阈值，看不到别的协会', async () => {
    for (const c of [opAdminA(), orgAdminA(), managerA1()]) {
      const rows = await thresholdsOf(c);
      expect(rows).toHaveLength(DEFAULT_CRITICAL_RULES.length);
      expect(rows.every((r) => r.operator_id === f.operatorA)).toBe(true);
    }
    expect(await thresholdsOf(platform())).toHaveLength(0);
  });

  it('只有本协会的协会管理员能改，改动会记录操作人和前后数值', async () => {
    const [rule] = await thresholdsOf(opAdminA());
    if (!rule) throw new Error('no rule');

    // 健管师、机构管理员、别的协会管理员都改不了
    for (const c of [managerA1(), orgAdminA(), opAdminB()]) {
      const res = await withTenant(app, c, (trx) =>
        trx
          .updateTable('critical_thresholds')
          .set({ value: 1, updated_by: c.userId })
          .where('id', '=', rule.id)
          .execute(),
      );
      expect(Number(res[0]?.numUpdatedRows), c.role).toBe(0);
    }

    await withTenant(app, opAdminA(), (trx) =>
      trx
        .updateTable('critical_thresholds')
        .set({ value: 175, updated_by: f.users.operatorAdminA.id, updated_at: new Date() })
        .where('id', '=', rule.id)
        .execute(),
    );
    const events = await withTenant(app, opAdminA(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .selectAll()
        .where('threshold_id', '=', rule.id)
        .where('action', '=', 'updated')
        .execute(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: f.users.operatorAdminA.id,
      operator_id: f.operatorA,
    });
    expect(Number((events[0]?.after as { value: number }).value)).toBe(175);

    // 别的协会看不到这条记录
    const seenByB = await withTenant(app, opAdminB(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .select('id')
        .where('threshold_id', '=', rule.id)
        .execute(),
    );
    expect(seenByB).toHaveLength(0);
  });

  it('不能替别的协会新增阈值，也不能冒用别人的名字', async () => {
    const values = {
      metric: 'creatinine',
      comparator: 'gte' as const,
      value: 500,
      level: 'attention' as const,
    };
    await expect(
      withTenant(app, opAdminA(), (trx) =>
        trx
          .insertInto('critical_thresholds')
          .values({ ...values, operator_id: f.operatorB, updated_by: f.users.operatorAdminA.id })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(app, opAdminA(), (trx) =>
        trx
          .insertInto('critical_thresholds')
          .values({ ...values, operator_id: f.operatorA, updated_by: f.users.platform.id })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('应用角色不能直接写修改记录', async () => {
    await expect(
      withTenant(app, opAdminA(), (trx) =>
        trx
          .insertInto('critical_threshold_events')
          .values({
            operator_id: f.operatorA,
            threshold_id: crypto.randomUUID(),
            actor_id: f.users.operatorAdminA.id,
            action: 'updated',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('只有平台管理员能改默认值；协会管理员能读，健管师读不到', async () => {
    const defaults = await withTenant(app, opAdminA(), (trx) =>
      trx.selectFrom('critical_threshold_defaults').selectAll().execute(),
    );
    expect(defaults).toHaveLength(DEFAULT_CRITICAL_RULES.length);
    const first = defaults[0];
    if (!first) throw new Error('no default');

    const byOperator = await withTenant(app, opAdminA(), (trx) =>
      trx
        .updateTable('critical_threshold_defaults')
        .set({ value: 1, updated_by: f.users.operatorAdminA.id })
        .where('id', '=', first.id)
        .execute(),
    );
    expect(Number(byOperator[0]?.numUpdatedRows)).toBe(0);

    const seenByManager = await withTenant(app, managerA1(), (trx) =>
      trx.selectFrom('critical_threshold_defaults').select('id').execute(),
    );
    expect(seenByManager).toHaveLength(0);

    const byPlatform = await withTenant(app, platform(), (trx) =>
      trx
        .updateTable('critical_threshold_defaults')
        .set({ enabled: false, updated_by: f.users.platform.id })
        .where('id', '=', first.id)
        .execute(),
    );
    expect(Number(byPlatform[0]?.numUpdatedRows)).toBe(1);

    // 平台改默认值的记录只有平台能看到
    const platformEvents = await withTenant(app, platform(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .selectAll()
        .where('threshold_id', '=', first.id)
        .execute(),
    );
    expect(platformEvents.some((e) => e.action === 'updated' && e.operator_id === null)).toBe(true);
    const operatorEvents = await withTenant(app, opAdminA(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .select('id')
        .where('threshold_id', '=', first.id)
        .execute(),
    );
    expect(operatorEvents).toHaveLength(0);

    // 恢复，避免影响后面的用例
    await owner
      .updateTable('critical_threshold_defaults')
      .set({ enabled: true })
      .where('id', '=', first.id)
      .execute();
  });

  it('删除规则也会记录', async () => {
    const [rule] = await thresholdsOf(opAdminA());
    if (!rule) throw new Error('no rule');
    await withTenant(app, opAdminA(), (trx) =>
      trx.deleteFrom('critical_thresholds').where('id', '=', rule.id).execute(),
    );
    const events = await withTenant(app, opAdminA(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .selectAll()
        .where('threshold_id', '=', rule.id)
        .where('action', '=', 'deleted')
        .execute(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toBeNull();
  });
});
