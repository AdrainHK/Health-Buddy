import { DEFAULT_CRITICAL_RULES } from '@health-buddy/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Db, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/** 危急指标阈值表的数据库层测试：全平台一套，只有平台管理员能改（规格第五节之二、Q12）。 */
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
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerB1 = () => ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB);
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

  it('所有角色读到的是同一套阈值', async () => {
    for (const c of [platform(), opAdminA(), orgAdminA(), managerA1(), managerB1()]) {
      expect(await thresholdsOf(c), c.role).toHaveLength(DEFAULT_CRITICAL_RULES.length);
    }
  });

  it('新建协会不再复制阈值', async () => {
    const before = await owner.selectFrom('critical_thresholds').select('id').execute();
    await owner.insertInto('operators').values({ name: '新协会', slug: 'assoc-new' }).execute();
    const after = await owner.selectFrom('critical_thresholds').select('id').execute();
    expect(after).toHaveLength(before.length);
  });

  it('只有平台管理员能改，改动会记录操作人和前后数值', async () => {
    const [rule] = await thresholdsOf(platform());
    if (!rule) throw new Error('no rule');

    for (const c of [opAdminA(), orgAdminA(), managerA1()]) {
      const res = await withTenant(app, c, (trx) =>
        trx
          .updateTable('critical_thresholds')
          .set({ value: 1, updated_by: c.userId })
          .where('id', '=', rule.id)
          .execute(),
      );
      expect(Number(res[0]?.numUpdatedRows), c.role).toBe(0);
      const del = await withTenant(app, c, (trx) =>
        trx.deleteFrom('critical_thresholds').where('id', '=', rule.id).execute(),
      );
      expect(Number(del[0]?.numDeletedRows), c.role).toBe(0);
    }

    await withTenant(app, platform(), (trx) =>
      trx
        .updateTable('critical_thresholds')
        .set({ value: 175, updated_by: f.users.platform.id, updated_at: new Date() })
        .where('id', '=', rule.id)
        .execute(),
    );
    const events = await withTenant(app, platform(), (trx) =>
      trx
        .selectFrom('critical_threshold_events')
        .selectAll()
        .where('threshold_id', '=', rule.id)
        .where('action', '=', 'updated')
        .execute(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: f.users.platform.id });
    expect(Number((events[0]?.before as { value: number }).value)).toBe(Number(rule.value));
    expect(Number((events[0]?.after as { value: number }).value)).toBe(175);

    // 修改记录只有平台管理员能看
    for (const c of [opAdminA(), orgAdminA(), managerA1()]) {
      const seen = await withTenant(app, c, (trx) =>
        trx.selectFrom('critical_threshold_events').select('id').execute(),
      );
      expect(seen, c.role).toHaveLength(0);
    }
  });

  it('其他角色不能新增，平台管理员也不能冒用别人的名字', async () => {
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
          .values({ ...values, updated_by: f.users.operatorAdminA.id })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(app, platform(), (trx) =>
        trx
          .insertInto('critical_thresholds')
          .values({ ...values, updated_by: f.users.operatorAdminA.id })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('应用角色不能直接写修改记录', async () => {
    await expect(
      withTenant(app, platform(), (trx) =>
        trx
          .insertInto('critical_threshold_events')
          .values({
            threshold_id: crypto.randomUUID(),
            actor_id: f.users.platform.id,
            action: 'updated',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('删除规则也会记录', async () => {
    const [rule] = await thresholdsOf(platform());
    if (!rule) throw new Error('no rule');
    await withTenant(app, platform(), (trx) =>
      trx.deleteFrom('critical_thresholds').where('id', '=', rule.id).execute(),
    );
    const events = await withTenant(app, platform(), (trx) =>
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
