import {
  DEFAULT_TWIN_STATUS_RULES,
  THRESHOLD_BOUNDS,
  TWIN_DOMAINS,
  domainMetrics,
  indicatorUnit,
  type IndicatorCode,
} from '@health-buddy/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  withTenant,
  type Db,
  type TenantContext,
  type TenantTransaction,
} from '../src/db/database.js';
import { TWIN_RULE_METRICS_SNAPSHOT } from '../src/db/migrations/0016-client-twin.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * M4 客户数字孪生数据表的数据库层隔离和约束测试（规格 7.1、7.2，验收标准 24–28）。
 * 以应用角色 hb_app 直接连接，绕过仓储层：即使以后的仓储层写错了查询，行级安全也拦得住。
 * 全部是虚构数据。
 */
describe('孪生数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const TWIN_TABLES = [
    'monitoring_readings',
    'twin_status_history',
    'twin_forecasts',
    'follow_up_items',
    'follow_up_events',
  ] as const;
  /** 机构管理员能读的表（Q20） */
  const ORG_ADMIN_TABLES = ['monitoring_readings', 'twin_status_history'] as const;

  const ctx = (
    id: string,
    role: TenantContext['role'],
    operatorId: string | null,
    orgId: string | null,
  ): TenantContext => ({ userId: id, role, operatorId, orgId });
  const managerA1 = () => ctx(f.users.managerA1.id, 'manager', f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, 'manager', f.operatorA, f.orgA);
  const managerA3 = () => ctx(f.users.managerA3.id, 'manager', f.operatorA, f.orgA2);
  const managerB1 = () => ctx(f.users.managerB1.id, 'manager', f.operatorB, f.orgB);
  const orgAdminA = () => ctx(f.users.orgAdminA.id, 'org_admin', f.operatorA, f.orgA);
  const orgAdminA2 = () => ctx(f.users.orgAdminA2.id, 'org_admin', f.operatorA, f.orgA2);
  const operatorAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);

  const asA1 = <T>(fn: (trx: TenantTransaction) => Promise<T>) => withTenant(app, managerA1(), fn);

  const statusRow = (clientId: string) => ({
    client_id: clientId,
    domain: 'metabolic' as const,
    level: 'yellow' as const,
    origin: 'computed' as const,
    basis: JSON.stringify([]),
    rules_version: 1,
    trigger: 'monitoring' as const,
  });
  const manualRow = (clientId: string, over: Record<string, unknown> = {}) => ({
    client_id: clientId,
    domain: 'metabolic' as const,
    level: 'green' as const,
    origin: 'manual' as const,
    basis: JSON.stringify([]),
    rules_version: 1,
    trigger: 'manual' as const,
    reason: '合成理由：已电话复核',
    manual_expires: 'next_data' as const,
    set_by: f.users.managerA1.id,
    ...over,
  });
  const forecastRow = (clientId: string, metric = 'sbp') => ({
    client_id: clientId,
    metric,
    source: 'report' as const,
    method_version: 'ols-linear-v1',
    points: JSON.stringify([]),
    n_points: 2,
    span_days: 120,
    status: 'insufficient_data' as const,
    insufficient_reason: 'too_few_points' as const,
    points_needed: 1,
  });
  const followUpRow = (clientId: string, over: Record<string, unknown> = {}) => ({
    client_id: clientId,
    kind: 'status_worsened' as const,
    severity: 3 as const,
    domain: 'metabolic' as const,
    basis: JSON.stringify({ from: 'green', to: 'yellow' }),
    source_ref: JSON.stringify({}),
    dedupe_key: 'status_worsened:metabolic',
    ...over,
  });

  /** 以所有者身份给客户写一套孪生数据（全部是虚构数据） */
  async function seedTwin(clientId: string) {
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: clientId,
        metric: 'weight',
        value: 66,
        unit: 'kg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
    await owner.insertInto('twin_status_history').values(statusRow(clientId)).execute();
    await owner.insertInto('twin_forecasts').values(forecastRow(clientId)).execute();
    await owner
      .insertInto('follow_up_items')
      .values(followUpRow(clientId))
      .returning('id')
      .executeTakeFirstOrThrow();
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
    for (const clientId of [f.clients.a1[0], f.clients.a2, f.clients.a3, f.clients.b1]) {
      await seedTwin(clientId);
    }
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  async function clientIdsSeenBy(c: TenantContext) {
    return withTenant(app, c, async (trx) => {
      const seen: Record<string, string[]> = {};
      for (const t of TWIN_TABLES) {
        const rows = await trx.selectFrom(t).select('client_id').execute();
        seen[t] = [...new Set(rows.map((r) => r.client_id))].sort();
      }
      return seen;
    });
  }
  const each = (ids: string[], tables: readonly string[] = TWIN_TABLES) =>
    Object.fromEntries(TWIN_TABLES.map((t) => [t, tables.includes(t) ? [...ids].sort() : []]));

  it('没有租户上下文时，应用角色查不到任何孪生数据和规则', async () => {
    for (const table of [
      ...TWIN_TABLES,
      'twin_status_rules',
      'twin_rules_version',
      'twin_status_rule_events',
    ] as const) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('逐表：健管师只看到自己的客户；同协会其他健管师、协会B、运营商、平台都看不到', async () => {
    // fixtures 里 a1[0] 和 b1 各有一条 M0 的合成监测读数，seedTwin 又各写了一条
    expect(await clientIdsSeenBy(managerA1())).toEqual(each([f.clients.a1[0]]));
    expect(await clientIdsSeenBy(managerA2())).toEqual(each([f.clients.a2]));
    expect(await clientIdsSeenBy(managerA3())).toEqual(each([f.clients.a3]));
    expect(await clientIdsSeenBy(managerB1())).toEqual(each([f.clients.b1]));
    expect(await clientIdsSeenBy(operatorAdminA())).toEqual(each([]));
    expect(await clientIdsSeenBy(platform())).toEqual(each([]));
  });

  it('机构管理员只读本机构的监测数据和状态历史，看不到预测和跟进清单（Q20）', async () => {
    expect(await clientIdsSeenBy(orgAdminA())).toEqual(
      each([f.clients.a1[0], f.clients.a2], ORG_ADMIN_TABLES),
    );
    expect(await clientIdsSeenBy(orgAdminA2())).toEqual(each([f.clients.a3], ORG_ADMIN_TABLES));
    // 也不能写
    await expect(
      withTenant(app, orgAdminA(), (trx) =>
        trx.insertInto('twin_status_history').values(statusRow(f.clients.a1[0])).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('监测数据：已有读数按客户回填了租户列', async () => {
    const rows = await owner
      .selectFrom('monitoring_readings as r')
      .innerJoin('clients as c', 'c.id', 'r.client_id')
      .select([
        'r.operator_id',
        'r.org_id',
        'r.manager_id',
        'c.operator_id as c_operator',
        'c.org_id as c_org',
        'c.manager_id as c_manager',
      ])
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect([r.operator_id, r.org_id, r.manager_id]).toEqual([r.c_operator, r.c_org, r.c_manager]);
    }
  });

  it('运营商和平台管理员不能给任何客户写孪生数据', async () => {
    for (const c of [operatorAdminA(), platform()]) {
      const item = await owner
        .selectFrom('follow_up_items')
        .select('id')
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow();
      for (const [label, attempt] of [
        [
          'status',
          (trx: TenantTransaction) =>
            trx.insertInto('twin_status_history').values(statusRow(f.clients.a1[0])).execute(),
        ],
        [
          'forecast',
          (trx: TenantTransaction) =>
            trx.insertInto('twin_forecasts').values(forecastRow(f.clients.a1[0], 'dbp')).execute(),
        ],
        [
          'follow-up',
          (trx: TenantTransaction) =>
            trx
              .insertInto('follow_up_items')
              .values(followUpRow(f.clients.a1[0], { dedupe_key: 'op' }))
              .execute(),
        ],
        [
          'event',
          (trx: TenantTransaction) =>
            trx
              .insertInto('follow_up_events')
              .values({
                client_id: f.clients.a1[0],
                item_id: item.id,
                actor_id: c.userId,
                action: 'consulted',
              })
              .execute(),
        ],
        [
          'reading',
          (trx: TenantTransaction) =>
            trx
              .insertInto('monitoring_readings')
              .values({
                client_id: f.clients.a1[0],
                metric: 'sbp',
                value: 120,
                unit: 'mmHg',
                measured_at: new Date(),
                source: 'manual',
                created_by: c.userId,
              })
              .execute(),
        ],
      ] as const) {
        await expect(withTenant(app, c, attempt), `${c.role} ${label}`).rejects.toMatchObject({
          code: '42501',
        });
      }
    }
  });

  describe('跨租户写入被拒绝', () => {
    const targets = () => [f.clients.a2, f.clients.a3, f.clients.b1];

    it('不能给同协会其他健管师、别的机构或协会B的客户写状态、预测、跟进项', async () => {
      for (const clientId of targets()) {
        for (const [label, attempt] of [
          [
            'status',
            (trx: TenantTransaction) =>
              trx.insertInto('twin_status_history').values(statusRow(clientId)).execute(),
          ],
          [
            'manual',
            (trx: TenantTransaction) =>
              trx.insertInto('twin_status_history').values(manualRow(clientId)).execute(),
          ],
          [
            'forecast',
            (trx: TenantTransaction) =>
              trx.insertInto('twin_forecasts').values(forecastRow(clientId, 'dbp')).execute(),
          ],
          [
            'follow-up',
            (trx: TenantTransaction) =>
              trx
                .insertInto('follow_up_items')
                .values(followUpRow(clientId, { dedupe_key: 'x' }))
                .execute(),
          ],
          [
            'reading',
            (trx: TenantTransaction) =>
              trx
                .insertInto('monitoring_readings')
                .values({
                  client_id: clientId,
                  metric: 'sbp',
                  value: 120,
                  unit: 'mmHg',
                  measured_at: new Date(),
                  source: 'manual',
                  created_by: f.users.managerA1.id,
                })
                .execute(),
          ],
        ] as const) {
          await expect(asA1(attempt), `${label} ${clientId}`).rejects.toMatchObject({
            code: '42501',
          });
        }
      }
    });

    it('请求里给错租户列也没用：租户列按客户填写，写到别人名下被拒绝', async () => {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('twin_status_history')
            .values({
              ...statusRow(f.clients.b1),
              operator_id: f.operatorA,
              org_id: f.orgA,
              manager_id: f.users.managerA1.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('改不了、删不了、处理不了别人的跟进项和预测（查不到，0 行）', async () => {
      const result = await asA1(async (trx) => ({
        followUp: await trx
          .updateTable('follow_up_items')
          .set({ status: 'done', resolution: 'called' })
          .where('client_id', '=', f.clients.b1)
          .executeTakeFirst(),
        forecast: await trx
          .updateTable('twin_forecasts')
          .set({ superseded_at: new Date() })
          .where('client_id', '=', f.clients.a2)
          .executeTakeFirst(),
        reading: await trx
          .deleteFrom('monitoring_readings')
          .where('client_id', '=', f.clients.b1)
          .executeTakeFirst(),
      }));
      expect(result.followUp.numUpdatedRows).toBe(0n);
      expect(result.forecast.numUpdatedRows).toBe(0n);
      expect(result.reading.numDeletedRows).toBe(0n);
    });

    it('跟进记录不能挂到别人的跟进项上', async () => {
      const other = await owner
        .selectFrom('follow_up_items')
        .select('id')
        .where('client_id', '=', f.clients.b1)
        .executeTakeFirstOrThrow();
      await expect(
        asA1((trx) =>
          trx
            .insertInto('follow_up_events')
            .values({
              client_id: f.clients.a1[0],
              item_id: other.id,
              actor_id: f.users.managerA1.id,
              action: 'consulted',
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('状态历史', () => {
    it('只能追加：直接修改或删除被拒绝', async () => {
      await expect(
        asA1((trx) =>
          trx
            .updateTable('twin_status_history')
            // @ts-expect-error 类型上也不允许修改
            .set({ level: 'green' })
            .where('client_id', '=', f.clients.a1[0])
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) =>
          trx.deleteFrom('twin_status_history').where('client_id', '=', f.clients.a1[0]).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('即使有了修改权限：没有修改策略，改不到任何行；系统身份以外也过不了触发器', async () => {
      await sql`grant update, delete on twin_status_history to hb_app`.execute(owner);
      try {
        const result = await asA1(async (trx) => ({
          updated:
            await sql`update twin_status_history set level = 'green' where client_id = ${f.clients.a1[0]}`.execute(
              trx,
            ),
          deleted:
            await sql`delete from twin_status_history where client_id = ${f.clients.a1[0]}`.execute(
              trx,
            ),
        }));
        expect(result.updated.numAffectedRows).toBe(0n);
        expect(result.deleted.numAffectedRows).toBe(0n);
      } finally {
        await sql`revoke update, delete on twin_status_history from hb_app`.execute(owner);
      }
      // 触发器本身：非所有者身份（这里用一个临时策略模拟）修改时被拒绝
      await sql`create policy tmp_update on twin_status_history for update using (true)`.execute(
        owner,
      );
      await sql`grant update on twin_status_history to hb_app`.execute(owner);
      try {
        await expect(
          asA1((trx) =>
            sql`update twin_status_history set level = 'green' where client_id = ${f.clients.a1[0]}`.execute(
              trx,
            ),
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await sql`revoke update on twin_status_history from hb_app`.execute(owner);
        await sql`drop policy tmp_update on twin_status_history`.execute(owner);
      }
    });

    it('手动调整必须写理由（不少于 5 个字），只能以本人名义，不能调成“数据不足”', async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ['没有理由', { reason: null }, '23514'],
        ['理由太短', { reason: '  正常 ' }, '23514'],
        ['没有失效方式', { manual_expires: null }, '23514'],
        ['调成灰', { level: 'unknown' }, '23514'],
        ['冒用别人', { set_by: f.users.managerA2.id }, '23514'],
        ['手动调整却标为系统计算', { origin: 'computed' }, '23514'],
      ];
      for (const [label, over, code] of cases) {
        await expect(
          asA1((trx) =>
            trx
              .insertInto('twin_status_history')
              .values(manualRow(f.clients.a1[0], over) as never)
              .execute(),
          ),
          label,
        ).rejects.toMatchObject({ code });
      }
      // 系统计算的状态不能带调整人和理由
      await expect(
        asA1((trx) =>
          trx
            .insertInto('twin_status_history')
            .values({ ...statusRow(f.clients.a1[0]), set_by: f.users.managerA1.id })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const row = await asA1((trx) =>
        trx
          .insertInto('twin_status_history')
          .values(manualRow(f.clients.a1[0]))
          .returning(['set_by', 'manager_id', 'org_id', 'operator_id'])
          .executeTakeFirstOrThrow(),
      );
      expect(row).toEqual({
        set_by: f.users.managerA1.id,
        manager_id: f.users.managerA1.id,
        org_id: f.orgA,
        operator_id: f.operatorA,
      });
      // 取消调整
      await asA1((trx) =>
        trx
          .insertInto('twin_status_history')
          .values({
            ...statusRow(f.clients.a1[0]),
            origin: 'manual_cleared',
            trigger: 'manual',
            set_by: f.users.managerA1.id,
          })
          .execute(),
      );
    });
  });

  describe('预测', () => {
    it('只放行 superseded_at 从空变为有值，一次', async () => {
      const mark = () =>
        asA1((trx) =>
          trx
            .updateTable('twin_forecasts')
            .set({ superseded_at: new Date('2000-01-01') })
            .where('client_id', '=', f.clients.a1[0])
            .returning('superseded_at')
            .execute(),
        );
      const [row] = await mark();
      // 时间由数据库填写，不能倒填
      expect(row!.superseded_at!.getTime()).toBeGreaterThan(Date.parse('2020-01-01'));
      await expect(mark()).rejects.toMatchObject({ code: '23514' });
    });

    it('其他列改不了（没有权限），也删不了', async () => {
      await expect(
        asA1((trx) =>
          sql`update twin_forecasts set n_points = 9 where client_id = ${f.clients.a1[0]}`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) =>
          trx.deleteFrom('twin_forecasts').where('client_id', '=', f.clients.a1[0]).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('触发器兜底：有了修改权限也只能标记被替代', async () => {
      await sql`grant update on twin_forecasts to hb_app`.execute(owner);
      try {
        await expect(
          asA1((trx) =>
            sql`update twin_forecasts set n_points = 9, superseded_at = now() where client_id = ${f.clients.a1[0]}`.execute(
              trx,
            ),
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        // 收回表级权限会连带收回列级权限，补回迁移里的 update (superseded_at)
        await sql`revoke update on twin_forecasts from hb_app`.execute(owner);
        await sql`grant update (superseded_at) on twin_forecasts to hb_app`.execute(owner);
      }
    });

    it('每个指标只有一条当前预测；新写入的预测不能是已替代的', async () => {
      await expect(
        asA1((trx) =>
          trx.insertInto('twin_forecasts').values(forecastRow(f.clients.a1[0])).execute(),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await asA1(async (trx) => {
        await trx
          .updateTable('twin_forecasts')
          .set({ superseded_at: new Date() })
          .where('client_id', '=', f.clients.a1[0])
          .where('superseded_at', 'is', null)
          .execute();
        await trx.insertInto('twin_forecasts').values(forecastRow(f.clients.a1[0])).execute();
      });
      await expect(
        asA1((trx) =>
          sql`insert into twin_forecasts (client_id, metric, source, method_version, n_points, span_days, status, insufficient_reason, superseded_at)
              values (${f.clients.a1[0]}, 'weight', 'report', 'v', 0, 0, 'insufficient_data', 'too_few_points', now())`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('状态和内容要一致：有预测的必须有区间和不确定性', async () => {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('twin_forecasts')
            .values({ ...forecastRow(f.clients.a1[0], 'weight'), status: 'ok' })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('跟进清单', () => {
    const itemOf = async (clientId: string) =>
      (
        await owner
          .selectFrom('follow_up_items')
          .select('id')
          .where('client_id', '=', clientId)
          .executeTakeFirstOrThrow()
      ).id;

    it('同一客户同一去重键未处理时不能重复生成；新建只能是 open', async () => {
      await expect(
        asA1((trx) =>
          trx.insertInto('follow_up_items').values(followUpRow(f.clients.a1[0])).execute(),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        asA1((trx) =>
          sql`insert into follow_up_items (client_id, kind, severity, domain, dedupe_key, status, resolved_by, resolved_at, resolution)
              values (${f.clients.a1[0]}, 'status_red', 2, 'weight', 'new', 'done', ${f.users.managerA1.id}, now(), 'called')`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('严重程度和类型要对应', async () => {
      await expect(
        asA1((trx) =>
          trx
            .insertInto('follow_up_items')
            .values(
              followUpRow(f.clients.a1[0], { kind: 'critical', severity: 3, dedupe_key: 'c' }),
            )
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('危急类不能忽略（数据库拒绝）', async () => {
      const id = await asA1(
        async (trx) =>
          (
            await trx
              .insertInto('follow_up_items')
              .values(
                followUpRow(f.clients.a1[0], {
                  kind: 'critical',
                  severity: 1,
                  domain: null,
                  metric: 'sbp',
                  dedupe_key: 'critical:sbp',
                }),
              )
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
      );
      await expect(
        asA1((trx) =>
          trx
            .updateTable('follow_up_items')
            .set({ status: 'dismissed', dismiss_reason: 'known' })
            .where('id', '=', id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('处理人和时间按当前用户填写；已处理的只能重新打开；记录不含备注', async () => {
      const id = await itemOf(f.clients.a1[0]);
      const done = await asA1((trx) =>
        trx
          .updateTable('follow_up_items')
          .set({
            status: 'done',
            resolution: 'called',
            note: '合成备注',
            resolved_by: f.users.managerA2.id,
          })
          .where('id', '=', id)
          .returning(['resolved_by', 'resolved_at'])
          .executeTakeFirstOrThrow(),
      );
      expect(done.resolved_by).toBe(f.users.managerA1.id);
      expect(done.resolved_at).not.toBeNull();

      // 已处理后不能改备注、不能直接改成暂缓
      for (const set of [
        { note: '改备注' },
        { status: 'snoozed' as const, snooze_until: new Date(Date.now() + 86_400_000) },
      ]) {
        await expect(
          asA1((trx) => trx.updateTable('follow_up_items').set(set).where('id', '=', id).execute()),
        ).rejects.toMatchObject({ code: '23514' });
      }
      // 重新打开：处理方式清空，备注保留（Q23）
      const reopened = await asA1((trx) =>
        trx
          .updateTable('follow_up_items')
          .set({ status: 'open' })
          .where('id', '=', id)
          .returning(['status', 'resolution', 'resolved_by', 'note'])
          .executeTakeFirstOrThrow(),
      );
      expect(reopened).toEqual({
        status: 'open',
        resolution: null,
        resolved_by: null,
        note: '合成备注',
      });

      const events = await asA1((trx) =>
        trx
          .selectFrom('follow_up_events')
          .selectAll()
          .where('item_id', '=', id)
          .orderBy('id')
          .execute(),
      );
      expect(events.map((e) => [e.action, e.actor_id])).toEqual([
        ['created', null],
        ['done', f.users.managerA1.id],
        ['reopened', f.users.managerA1.id],
      ]);
      expect(Object.keys(events[0]!)).not.toContain('note');
    });

    it('暂缓必须到将来；重新触发只更新时间并记一条记录', async () => {
      const id = await itemOf(f.clients.a1[0]);
      await expect(
        asA1((trx) =>
          trx
            .updateTable('follow_up_items')
            .set({ status: 'snoozed', snooze_until: new Date(Date.now() - 1000) })
            .where('id', '=', id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await asA1((trx) =>
        trx
          .updateTable('follow_up_items')
          .set({ last_triggered_at: new Date('2000-01-01') })
          .where('id', '=', id)
          .execute(),
      );
      const row = await owner
        .selectFrom('follow_up_items')
        .select('last_triggered_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.last_triggered_at.getTime()).toBeGreaterThan(Date.parse('2020-01-01'));
      const actions = await owner
        .selectFrom('follow_up_events')
        .select(['action', 'actor_id'])
        .where('item_id', '=', id)
        .orderBy('id')
        .execute();
      expect(actions).toEqual([
        { action: 'created', actor_id: null },
        { action: 'retriggered', actor_id: null },
      ]);
    });

    it('客户、类型、去重键改不了；跟进项和记录删不了', async () => {
      const id = await itemOf(f.clients.a1[0]);
      for (const stmt of [
        sql`update follow_up_items set kind = 'status_red' where id = ${id}`,
        sql`update follow_up_items set client_id = ${f.clients.a1[1]} where id = ${id}`,
        sql`update follow_up_items set manager_id = ${f.users.managerA2.id} where id = ${id}`,
        sql`delete from follow_up_items where id = ${id}`,
        sql`update follow_up_events set action = 'done' where item_id = ${id}`,
        sql`delete from follow_up_events where item_id = ${id}`,
      ]) {
        await expect(asA1((trx) => stmt.execute(trx))).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('应用只能以本人名义记录“请专家看看”，其余记录由系统写', async () => {
      const id = await itemOf(f.clients.a1[0]);
      const event = (action: string, actor: string | null) =>
        asA1((trx) =>
          trx
            .insertInto('follow_up_events')
            .values({ client_id: f.clients.a1[0], item_id: id, actor_id: actor, action } as never)
            .execute(),
        );
      await expect(event('done', f.users.managerA1.id)).rejects.toMatchObject({ code: '23514' });
      await expect(event('consulted', f.users.managerA2.id)).rejects.toMatchObject({
        code: '23514',
      });
      await event('consulted', f.users.managerA1.id);
    });
  });

  describe('手动录入的监测读数（Q29）', () => {
    const manual = (over: Record<string, unknown> = {}) => ({
      client_id: f.clients.a1[0],
      metric: 'sbp',
      value: 128,
      unit: 'mmHg',
      measured_at: new Date(),
      source: 'manual' as const,
      created_by: f.users.managerA1.id,
      ...over,
    });

    it('应用只能以本人名义手动录入，不能写其他来源，不能是将来的时间', async () => {
      for (const [label, over] of [
        ['冒充合成数据', { source: 'synthetic', created_by: null }],
        ['冒充设备', { source: 'device', created_by: null }],
        ['冒用别人', { created_by: f.users.managerA2.id }],
        ['没有录入人', { created_by: null }],
        ['将来的时间', { measured_at: new Date(Date.now() + 86_400_000) }],
      ] as const) {
        await expect(
          asA1((trx) =>
            trx
              .insertInto('monitoring_readings')
              .values(manual(over) as never)
              .execute(),
          ),
          label,
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('只能删除自己手动录入的读数；合成数据不能删；读数不能修改', async () => {
      const id = await asA1(
        async (trx) =>
          (
            await trx
              .insertInto('monitoring_readings')
              .values(manual())
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id,
      );
      await expect(
        asA1((trx) =>
          trx
            .deleteFrom('monitoring_readings')
            .where('client_id', '=', f.clients.a1[0])
            .where('source', '=', 'synthetic')
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) =>
          trx.updateTable('monitoring_readings').set({ value: 130 }).where('id', '=', id).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      // 客户转给 A2 后，A2 不能删 A1 录入的读数，A1 也看不到了
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      await expect(
        withTenant(app, managerA2(), (trx) =>
          trx.deleteFrom('monitoring_readings').where('id', '=', id).execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const gone = await asA1((trx) =>
        trx.deleteFrom('monitoring_readings').where('id', '=', id).executeTakeFirst(),
      );
      expect(gone.numDeletedRows).toBe(0n);
    });

    it('健管师能删自己刚录入的读数', async () => {
      const deleted = await asA1(async (trx) => {
        const row = await trx
          .insertInto('monitoring_readings')
          .values(manual())
          .returning('id')
          .executeTakeFirstOrThrow();
        return trx.deleteFrom('monitoring_readings').where('id', '=', row.id).executeTakeFirst();
      });
      expect(deleted.numDeletedRows).toBe(1n);
    });
  });

  describe('客户转出、调机构和删除（Q23）', () => {
    it('客户转给同机构的健管师：孪生数据和未处理的跟进项跟着转，原健管师看不到', async () => {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      expect(await clientIdsSeenBy(managerA1())).toEqual(each([]));
      const a2 = await clientIdsSeenBy(managerA2());
      for (const t of TWIN_TABLES) expect(a2[t], t).toContain(f.clients.a1[0]);
      // 新健管师可以继续处理转来的跟进项
      const updated = await withTenant(app, managerA2(), (trx) =>
        trx
          .updateTable('follow_up_items')
          .set({ status: 'done', resolution: 'called' })
          .where('client_id', '=', f.clients.a1[0])
          .executeTakeFirst(),
      );
      expect(updated.numUpdatedRows).toBe(1n);
    });

    it('客户转到别的机构：org_id 跟着变，两边的机构管理员各自看到对的数据', async () => {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
        .where('id', '=', f.clients.a1[0])
        .execute();
      for (const table of TWIN_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select(['manager_id', 'org_id'])
          .where('client_id', '=', f.clients.a1[0])
          .execute();
        expect(rows.length, table).toBeGreaterThan(0);
        for (const r of rows)
          expect(r, table).toEqual({ manager_id: f.users.managerA3.id, org_id: f.orgA2 });
      }
      const orgA = await clientIdsSeenBy(orgAdminA());
      const orgA2 = await clientIdsSeenBy(orgAdminA2());
      for (const t of ORG_ADMIN_TABLES) {
        expect(orgA[t], t).not.toContain(f.clients.a1[0]);
        expect(orgA2[t], t).toContain(f.clients.a1[0]);
      }
    });

    it('健管师调机构：新表的 org_id 跟着变', async () => {
      await owner
        .updateTable('users')
        .set({ org_id: f.orgA2 })
        .where('id', '=', f.users.managerA1.id)
        .execute();
      for (const table of TWIN_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select('org_id')
          .where('manager_id', '=', f.users.managerA1.id)
          .execute();
        expect(rows.length, table).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.org_id)), table).toEqual(new Set([f.orgA2]));
      }
    });

    it('客户的机构变了而健管师没变：租户列跟着同步', async () => {
      await owner
        .updateTable('clients')
        .set({ org_id: null })
        .where('id', '=', f.clients.a1[0])
        .execute();
      for (const table of TWIN_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select('org_id')
          .where('client_id', '=', f.clients.a1[0])
          .execute();
        expect(rows.length, table).toBeGreaterThan(0);
        for (const r of rows) expect(r.org_id, table).toBeNull();
      }
    });

    it('客户删除时孪生数据一起删除（包括只能追加的状态历史和跟进记录）', async () => {
      await asA1((trx) => trx.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute());
      for (const table of TWIN_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select('client_id')
          .where('client_id', '=', f.clients.a1[0])
          .execute();
        expect(rows, table).toHaveLength(0);
      }
    });
  });

  describe('状态规则（Q1：全平台一套，只有平台管理员能改）', () => {
    const asPlatform = <T>(fn: (trx: TenantTransaction) => Promise<T>) =>
      withTenant(app, platform(), fn);
    const version = async () =>
      (await owner.selectFrom('twin_rules_version').select('version').executeTakeFirstOrThrow())
        .version;
    const thresholdRule = (over: Record<string, unknown> = {}) => ({
      domain: 'cardiovascular' as const,
      metric: 'sbp',
      source: 'monitoring' as const,
      method: 'threshold' as const,
      comparator: 'gt' as const,
      value: 160,
      unit: 'mmHg',
      window_days: 14,
      level: 'red' as const,
      updated_by: f.users.platform.id,
      ...over,
    });

    it('迁移写入了默认规则；健管师、机构、协会、平台都能读规则和版本号', async () => {
      for (const c of [managerA1(), orgAdminA(), operatorAdminA(), platform()]) {
        const rows = await withTenant(app, c, async (trx) => ({
          rules: await trx.selectFrom('twin_status_rules').select('id').execute(),
          version: await trx.selectFrom('twin_rules_version').select('version').execute(),
        }));
        expect(rows.rules).toHaveLength(DEFAULT_TWIN_STATUS_RULES.length);
        expect(rows.version).toEqual([{ version: 1 }]);
      }
    });

    it('协会、机构管理员和健管师不能新增、修改、删除规则，也看不到修改记录', async () => {
      for (const c of [managerA1(), orgAdminA(), operatorAdminA()]) {
        await expect(
          withTenant(app, c, (trx) =>
            trx
              .insertInto('twin_status_rules')
              .values(thresholdRule({ updated_by: c.userId }))
              .execute(),
          ),
        ).rejects.toMatchObject({ code: '42501' });
        const result = await withTenant(app, c, async (trx) => ({
          updated: await trx
            .updateTable('twin_status_rules')
            .set({ enabled: false, updated_by: c.userId })
            .executeTakeFirst(),
          deleted: await trx.deleteFrom('twin_status_rules').executeTakeFirst(),
          events: await trx.selectFrom('twin_status_rule_events').select('id').execute(),
        }));
        expect(result.updated.numUpdatedRows).toBe(0n);
        expect(result.deleted.numDeletedRows).toBe(0n);
        expect(result.events).toHaveLength(0);
      }
      expect(await version()).toBe(1);
    });

    it('平台管理员修改规则：记录改前改后和操作人，同一事务只加一次版本号', async () => {
      await asPlatform(async (trx) => {
        await trx.insertInto('twin_status_rules').values(thresholdRule()).execute();
        await trx
          .updateTable('twin_status_rules')
          .set({ value: 145, updated_by: f.users.platform.id })
          .where('method', '=', 'threshold')
          .where('metric', '=', 'sbp')
          .where('window_days', '=', 7)
          .execute();
      });
      expect(await version()).toBe(2);
      const events = await asPlatform((trx) =>
        trx.selectFrom('twin_status_rule_events').selectAll().orderBy('id').execute(),
      );
      expect(events.map((e) => [e.action, e.actor_id, e.rules_version])).toEqual([
        ['created', f.users.platform.id, 2],
        ['updated', f.users.platform.id, 2],
      ]);
      expect(events[1]!.before).toMatchObject({ value: 140 });
      expect(events[1]!.after).toMatchObject({ value: 145 });

      await asPlatform((trx) =>
        trx
          .updateTable('twin_status_rules')
          .set({ enabled: false, updated_by: f.users.platform.id })
          .where('metric', '=', 'sleep_hours')
          .execute(),
      );
      expect(await version()).toBe(3);
    });

    it('不能以别人的名义修改', async () => {
      await expect(
        asPlatform((trx) =>
          trx
            .insertInto('twin_status_rules')
            .values(thresholdRule({ updated_by: f.users.managerA1.id }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('规则形状、单位和合理范围由数据库校验', async () => {
      for (const [label, over] of [
        ['单位不跟目录', { unit: 'kPa' }],
        ['阈值超出合理范围', { value: 1400 }],
        ['指标不属于这个方面', { domain: 'metabolic' }],
        ['不在目录里的指标', { metric: 'alt', unit: 'U/L' }],
        ['固定阈值缺比较方式', { comparator: null }],
        ['监测规则缺窗口', { window_days: null }],
        ['固定阈值用在报告上', { source: 'report', window_days: null }],
        ['参考范围类带了阈值', { method: 'out_of_reference', source: 'report', window_days: null }],
        ['得出绿色', { level: 'green' }],
      ] as const) {
        await expect(
          asPlatform((trx) =>
            trx
              .insertInto('twin_status_rules')
              .values(thresholdRule(over) as never)
              .execute(),
          ),
          label,
        ).rejects.toMatchObject({ code: '23514' });
      }
      // 同一方面、指标、来源、判断方式、比较方式、得出状态的规则只能有一条
      await expect(
        asPlatform((trx) =>
          trx
            .insertInto('twin_status_rules')
            .values(thresholdRule({ value: 150, level: 'yellow' }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('恢复为默认值：只有平台管理员能做，记为 reset，版本号加一', async () => {
      const rules = JSON.stringify(
        DEFAULT_TWIN_STATUS_RULES.map((r) => ({
          domain: r.domain,
          metric: r.metric,
          source: r.source,
          method: r.method,
          comparator: r.comparator,
          value: r.value,
          unit: r.unit,
          window_days: r.windowDays,
          level: r.level,
          enabled: r.enabled ?? true,
          category: r.category ?? null,
          polarity: r.polarity ?? null,
          min_count: r.minCount ?? null,
        })),
      );
      for (const c of [managerA1(), operatorAdminA()]) {
        await expect(
          withTenant(app, c, (trx) =>
            sql`select twin_status_rules_reset(${rules}::jsonb)`.execute(trx),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await asPlatform((trx) => sql`select twin_status_rules_reset(${rules}::jsonb)`.execute(trx));
      expect(await version()).toBe(2);
      const events = await asPlatform((trx) =>
        trx.selectFrom('twin_status_rule_events').select(['action', 'actor_id']).execute(),
      );
      expect(events).toHaveLength(DEFAULT_TWIN_STATUS_RULES.length * 2);
      expect(new Set(events.map((e) => e.action))).toEqual(new Set(['reset']));
      expect(new Set(events.map((e) => e.actor_id))).toEqual(new Set([f.users.platform.id]));
      // 恢复后的规则以平台管理员名义写入，和默认值一致
      const after = await asPlatform((trx) =>
        trx.selectFrom('twin_status_rules').select(['updated_by']).execute(),
      );
      expect(after).toHaveLength(DEFAULT_TWIN_STATUS_RULES.length);
      expect(new Set(after.map((r) => r.updated_by))).toEqual(new Set([f.users.platform.id]));
    });

    it('恢复为默认值：空列表或非数组被拒绝，规则不被清空', async () => {
      for (const bad of ['[]', '{}', 'null']) {
        await expect(
          asPlatform((trx) => sql`select twin_status_rules_reset(${bad}::jsonb)`.execute(trx)),
        ).rejects.toMatchObject({ code: '22023' });
      }
      const rules = await asPlatform((trx) =>
        trx.selectFrom('twin_status_rules').select('id').execute(),
      );
      expect(rules).toHaveLength(DEFAULT_TWIN_STATUS_RULES.length);
      expect(await version()).toBe(1);
    });
    it('自己设会话变量或写标记表都不能把普通修改记成 reset', async () => {
      await asPlatform(async (trx) => {
        await sql`select set_config('hb.twin_rules_reset', 'on', true)`.execute(trx);
        await trx
          .updateTable('twin_status_rules')
          .set({ enabled: false, updated_by: f.users.platform.id })
          .where('metric', '=', 'sleep_hours')
          .execute();
      });
      const events = await asPlatform((trx) =>
        trx.selectFrom('twin_status_rule_events').select('action').execute(),
      );
      expect(events.map((e) => e.action)).toEqual(['updated']);
      await expect(
        asPlatform((trx) =>
          sql`insert into twin_rules_reset_marker (xact) values (pg_current_xact_id())`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('迁移里的指标目录快照和 packages/shared 一致（目录变了要另加迁移）', () => {
    const expected = TWIN_DOMAINS.flatMap((d) =>
      (['report', 'monitoring'] as const).flatMap((s) =>
        (domainMetrics[d][s] as readonly IndicatorCode[]).map((m) => [
          d,
          s,
          m,
          indicatorUnit(m),
          THRESHOLD_BOUNDS[m].min,
          THRESHOLD_BOUNDS[m].max,
        ]),
      ),
    );
    expect([...TWIN_RULE_METRICS_SNAPSHOT].map((r) => [...r]).sort()).toEqual(expected.sort());
  });
});
