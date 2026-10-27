import { randomUUID } from 'node:crypto';
import {
  ALLERGENS,
  DEFAULT_VISIT_FREQUENCY_RULES,
  EXERCISE_CATEGORIES,
  LIBRARY_TAGS,
  MEAL_TYPES,
  PLAN_SECTIONS,
  VISIT_METHODS,
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
import { ALLERGEN_SNAPSHOT_0021 } from '../src/db/migrations/0021-sesame-allergen.js';
import {
  PLAN_ENUM_SNAPSHOT,
  VISIT_FREQUENCY_SNAPSHOT,
} from '../src/db/migrations/0020-plan-followup.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/**
 * M5 方案和随访数据表的数据库层隔离和约束测试（规格 6.1、6.2，验收标准 20、25–28）。
 * 以应用角色 hb_app 直接连接，绕过仓储层：即使以后的仓储层写错了查询，行级安全也拦得住。
 * 全部是虚构数据。
 */
describe('方案和随访数据表的行级安全和约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;

  const CLIENT_TABLES = [
    'care_plans',
    'visits',
    'client_record_consents',
    'visit_materials',
    'visit_records',
    'visit_record_addenda',
    'visit_events',
  ] as const;
  const PLATFORM_TABLES = [
    'plan_library_recipes',
    'plan_library_exercises',
    'plan_goal_templates',
    'plan_library_events',
    'visit_frequency_rules',
    'visit_frequency_config',
    'visit_frequency_version',
    'visit_frequency_rule_events',
  ] as const;

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
  const operatorAdminA = () => ctx(f.users.operatorAdminA.id, 'operator_admin', f.operatorA, null);
  const platform = () => ctx(f.users.platform.id, 'platform_admin', null, null);
  const as = <T>(c: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) =>
    withTenant(app, c, fn);
  const asA1 = <T>(fn: (trx: TenantTransaction) => Promise<T>) => as(managerA1(), fn);

  /** 已发布的库条目（以所有者身份写入，相当于种子导入） */
  let lib: {
    recipe: string;
    allergenRecipe: string;
    exercise: string;
    goal: string;
    draftRecipe: string;
  };

  async function seedLibrary() {
    const published = {
      status: 'published',
      reviewed_by_label: '合成审定人',
      reviewed_on: '2026-10-01',
      source_note: '合成测试条目',
    };
    const recipe = (
      code: string,
      allergens: string[],
      status: Record<string, unknown> = published,
    ) =>
      owner
        .insertInto('plan_library_recipes')
        .values({
          code,
          name: `合成食谱 ${code}`,
          meal_types: ['breakfast'],
          ingredients: JSON.stringify([{ name: '燕麦', householdAmount: '半碗' }]),
          steps: JSON.stringify(['煮开']),
          tags: ['high_fiber'],
          allergens,
          ...status,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    lib = {
      recipe: (await recipe('oat-porridge', [])).id,
      allergenRecipe: (await recipe('peanut-toast', ['peanut'])).id,
      draftRecipe: (await recipe('draft-dish', [], { status: 'draft', source_note: '草稿' })).id,
      exercise: (
        await owner
          .insertInto('plan_library_exercises')
          .values({
            code: 'brisk-walk',
            name: '快走',
            category: 'aerobic',
            intensity: 'low',
            setting: ['outdoor'],
            steps: JSON.stringify(['抬头挺胸']),
            key_points: JSON.stringify(['微微出汗']),
            manager_cautions: '合成注意事项',
            ...published,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      goal: (
        await owner
          .insertInto('plan_goal_templates')
          .values({
            code: 'daily-steps',
            section: 'exercise',
            text: '每天步行 {steps} 步',
            params: JSON.stringify([
              { name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' },
            ]),
            metric: 'steps',
            metric_param: 'steps',
            ...published,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
    };
  }

  const carePlanStructured = (over: Record<string, unknown> = {}) => ({
    sections: [
      { section: 'diet', professional: '合成', clientFacing: '合成', goals: [] },
      {
        section: 'exercise',
        professional: '合成',
        clientFacing: '合成',
        goals: [{ templateId: lib.goal, params: { steps: 6000 } }],
      },
    ],
    recipes: [{ day: 1, meal: 'breakfast', recipeId: lib.recipe }],
    exercises: [{ exerciseId: lib.exercise, frequencyPerWeek: 3, minutes: 20 }],
    ...over,
  });

  /** 以健管师身份新建任务和一份草稿产物 */
  async function draft(
    c: TenantContext,
    clientId: string,
    kind: 'care_plan' | 'visit_schedule' | 'visit_record' | 'visit_script',
    structured: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    return as(c, async (trx) => {
      const task = await trx
        .insertInto('tasks')
        .values({
          operator_id: c.operatorId ?? '',
          org_id: c.orgId,
          manager_id: c.userId,
          client_id: clientId,
          title: '合成任务',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const id = randomUUID();
      await trx
        .insertInto('artifacts')
        .values({
          id,
          operator_id: c.operatorId ?? '',
          org_id: c.orgId,
          manager_id: c.userId,
          task_id: task.id,
          client_id: clientId,
          skill_id: kind.replace('_', '-'),
          kind,
          lineage_id: id,
          version: 1,
          status: 'draft',
          content: JSON.stringify({ professional: '合成专业版', clientFacing: '' }),
          structured: structured === null ? null : JSON.stringify(structured),
          plan_options:
            kind === 'care_plan'
              ? JSON.stringify({ sections: ['diet', 'exercise'], cycleWeeks: 8 })
              : null,
          ...extra,
        })
        .execute();
      return id;
    });
  }

  const call = (trx: TenantTransaction, fn: string, ...args: unknown[]) =>
    sql<{ r: unknown }>`select ${sql.raw(fn)}(${sql.join(args)}) as r`
      .execute(trx)
      .then((x) => x.rows[0]?.r);

  const recordStructured = (over: Record<string, unknown> = {}) => ({
    visitDate: '2026-10-20',
    method: 'phone',
    summary: '合成摘要',
    feedback: [],
    planProgress: [],
    agreements: [],
    attentionPoints: [],
    historySuggestions: [],
    openQuestions: [],
    ...over,
  });

  /** 给客户走一遍：方案生效、随访计划、素材、记录和补充说明（全部是虚构数据） */
  async function seedClient(c: TenantContext, clientId: string) {
    const plan = await draft(c, clientId, 'care_plan', carePlanStructured());
    await as(c, (trx) => call(trx, 'approve_care_plan', plan));
    const schedule = await draft(c, clientId, 'visit_schedule', {
      rows: [{ dueDate: '2099-01-01', method: 'phone', purpose: 'routine', focus: null }].map(
        (r) => ({ ...r, dueDate: futureDate(10) }),
      ),
    });
    await as(c, (trx) => call(trx, 'approve_visit_schedule', schedule));
    const material = await as(c, async (trx) => {
      await trx
        .insertInto('client_record_consents')
        .values({ client_id: clientId, kind: 'visit_material', confirmed_by: c.userId })
        .execute();
      return (
        await trx
          .insertInto('visit_materials')
          .values({
            client_id: clientId,
            kind: 'paste',
            text_encrypted: Buffer.from('合成密文'),
            char_count: 4,
            uploaded_by: c.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const record = await draft(c, clientId, 'visit_record', recordStructured(), {
      material_ids: [material],
    });
    const recordId = (await as(c, (trx) => call(trx, 'approve_visit_record', record))) as string;
    await as(c, (trx) =>
      trx
        .insertInto('visit_record_addenda')
        .values({
          client_id: clientId,
          record_id: recordId,
          text: '合成补充说明',
          created_by: c.userId,
        })
        .execute(),
    );
    return { plan, schedule, material, record, recordId };
  }

  /** 北京时间今天之后 n 天（工作日不论） */
  function futureDate(n: number) {
    const d = new Date(Date.now() + 8 * 3600_000 + n * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  let seeded: Record<string, Awaited<ReturnType<typeof seedClient>>>;
  beforeEach(async () => {
    f = await seedFixtures(owner);
    await seedLibrary();
    seeded = {
      a1: await seedClient(managerA1(), f.clients.a1[0]),
      a2: await seedClient(managerA2(), f.clients.a2),
      a3: await seedClient(managerA3(), f.clients.a3),
      b1: await seedClient(managerB1(), f.clients.b1),
    };
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  async function clientIdsSeenBy(c: TenantContext) {
    return as(c, async (trx) => {
      const seen: Record<string, string[]> = {};
      for (const t of CLIENT_TABLES) {
        const rows = await trx.selectFrom(t).select('client_id').execute();
        seen[t] = [...new Set(rows.map((r) => r.client_id))].sort();
      }
      return seen;
    });
  }
  const each = (ids: string[]) =>
    Object.fromEntries(CLIENT_TABLES.map((t) => [t, [...ids].sort()]));

  it('迁移的固定取值和默认频次和 packages/shared 一致', () => {
    // 0021 把芝麻加进了过敏原
    expect(ALLERGEN_SNAPSHOT_0021).toEqual([...ALLERGENS]);
    expect([...PLAN_ENUM_SNAPSHOT.allergens, 'sesame']).toEqual([...ALLERGENS]);
    expect(PLAN_ENUM_SNAPSHOT.tags).toEqual([...LIBRARY_TAGS]);
    expect(PLAN_ENUM_SNAPSHOT.meals).toEqual([...MEAL_TYPES]);
    expect(PLAN_ENUM_SNAPSHOT.sections).toEqual([...PLAN_SECTIONS]);
    expect(PLAN_ENUM_SNAPSHOT.exerciseCategories).toEqual([...EXERCISE_CATEGORIES]);
    expect(PLAN_ENUM_SNAPSHOT.methods).toEqual([...VISIT_METHODS]);
    expect(
      Object.fromEntries(
        VISIT_FREQUENCY_SNAPSHOT.tiers.map(([t, i, m]) => [
          t,
          { intervalDays: i, defaultMethod: m },
        ]),
      ),
    ).toEqual(DEFAULT_VISIT_FREQUENCY_RULES.tiers);
    expect(VISIT_FREQUENCY_SNAPSHOT.firstVisitWithinDays).toBe(
      DEFAULT_VISIT_FREQUENCY_RULES.firstVisitWithinDays,
    );
  });

  it('没有租户上下文时，应用角色查不到任何方案、随访、方案库和频次规则', async () => {
    for (const table of [...CLIENT_TABLES, ...PLATFORM_TABLES]) {
      const rows = await app
        .selectFrom(table)
        .select(sql`1`.as('x'))
        .execute();
      expect(rows, table).toHaveLength(0);
    }
  });

  it('逐表：健管师只看到自己的客户；同机构、别的机构、协会B的健管师看不到', async () => {
    expect(await clientIdsSeenBy(managerA1())).toEqual(each([f.clients.a1[0]]));
    expect(await clientIdsSeenBy(managerA2())).toEqual(each([f.clients.a2]));
    expect(await clientIdsSeenBy(managerA3())).toEqual(each([f.clients.a3]));
    expect(await clientIdsSeenBy(managerB1())).toEqual(each([f.clients.b1]));
  });

  it('逐表：机构管理员、运营商、平台管理员看不到任何方案和随访明细（Q28），也写不了', async () => {
    for (const c of [orgAdminA(), operatorAdminA(), platform()]) {
      expect(await clientIdsSeenBy(c), c.role).toEqual(each([]));
      await expect(
        as(c, (trx) =>
          trx
            .insertInto('visits')
            .values({
              client_id: f.clients.a1[0],
              due_date: futureDate(3),
              method: 'phone',
              purpose: 'adhoc',
              origin: 'manual',
              created_by: c.userId,
            })
            .execute(),
        ),
        c.role,
      ).rejects.toMatchObject({ code: '42501' });
      const ended = await as(c, (trx) =>
        trx
          .updateTable('care_plans')
          .set({ status: 'ended', end_reason: 'other' })
          .executeTakeFirst(),
      );
      expect(ended.numUpdatedRows, c.role).toBe(0n);
    }
  });

  describe('只经确认函数写入（5.4 第 1 条，验收 20、27）', () => {
    it('应用角色不能直接写方案、随访记录、随访事件；随访计划类随访也不能直接写', async () => {
      await expect(
        asA1((trx) =>
          sql`insert into care_plans (client_id, lineage_id, sections, snapshot, cycle_weeks, start_date,
                review_date, status, approved_by)
              values (${f.clients.a1[0]}, ${randomUUID()}, '{diet}', '{}', 4, current_date,
                current_date + 28, 'active', ${f.users.managerA1.id})`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) =>
          sql`insert into visit_records (client_id, visit_date, method, snapshot, approved_by)
              values (${f.clients.a1[0]}, current_date, 'phone', '{}', ${f.users.managerA1.id})`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asA1((trx) =>
          sql`insert into visit_events (client_id, visit_id, action)
              select client_id, id, 'done' from visits limit 1`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      for (const origin of ['schedule', 'plan_review']) {
        await expect(
          asA1((trx) =>
            sql`insert into visits (client_id, due_date, method, purpose, origin, status, created_by)
                values (${f.clients.a1[0]}, ${futureDate(3)}, 'phone', 'plan_review', ${origin},
                  'planned', ${f.users.managerA1.id})`.execute(trx),
          ),
          origin,
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('方案、随访计划、随访记录的产物不能直接改为已审核；/随访话术可以', async () => {
      for (const [kind, structured] of [
        ['care_plan', carePlanStructured()],
        ['visit_schedule', { rows: [] }],
        ['visit_record', recordStructured()],
      ] as const) {
        const id = await draft(managerA1(), f.clients.a1[0], kind, structured);
        await expect(
          asA1((trx) =>
            trx.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute(),
          ),
          kind,
        ).rejects.toMatchObject({ code: '42501' });
      }
      const script = await draft(managerA1(), f.clients.a1[0], 'visit_script', null);
      const r = await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', script)
          .executeTakeFirst(),
      );
      expect(r.numUpdatedRows).toBe(1n);
    });

    it('确认函数：别人的产物（同机构、协会B）都按不存在处理，不写任何行', async () => {
      const before = await owner.selectFrom('care_plans').select('id').execute();
      for (const c of [managerA2(), managerB1(), managerA3()]) {
        const id = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
        await expect(as(c, (trx) => call(trx, 'approve_care_plan', id))).rejects.toMatchObject({
          code: 'P0002',
        });
        const row = await owner
          .selectFrom('artifacts')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(row.status).toBe('draft');
      }
      expect(await owner.selectFrom('care_plans').select('id').execute()).toHaveLength(
        before.length,
      );
    });

    it('确认函数：只有健管师能调用；已确认、kind 不对、不是最新草稿的都失败', async () => {
      const id = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
      for (const c of [orgAdminA(), operatorAdminA(), platform()]) {
        await expect(as(c, (trx) => call(trx, 'approve_care_plan', id))).rejects.toMatchObject({
          code: '42501',
        });
      }
      // kind 不对
      await expect(asA1((trx) => call(trx, 'approve_visit_schedule', id))).rejects.toMatchObject({
        code: '23514',
      });
      // 已确认
      await expect(
        asA1((trx) => call(trx, 'approve_care_plan', seeded.a1!.plan)),
      ).rejects.toMatchObject({
        code: '23514',
      });
      // 已有新版本时，旧版本不能确认
      await sql`
        insert into artifacts (id, task_id, client_id, operator_id, org_id, manager_id, skill_id, kind,
                               lineage_id, version, parent_id, status, content, structured, plan_options)
        select gen_random_uuid(), task_id, client_id, operator_id, org_id, manager_id, skill_id, kind,
               lineage_id, 2, id, 'draft', content, structured, plan_options
        from artifacts where id = ${id}
      `.execute(owner);
      await expect(asA1((trx) => call(trx, 'approve_care_plan', id))).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  describe('方案（2.3、2.6）', () => {
    const plansOf = (clientId: string) =>
      owner
        .selectFrom('care_plans')
        .select([
          'id',
          'status',
          'artifact_id',
          'cycle_weeks',
          'start_date',
          'review_date',
          'snapshot',
        ])
        .where('client_id', '=', clientId)
        .orderBy('approved_at')
        .execute();

    it('确认后生效：快照记下库条目版本，复评日期 = 生效日 + 周期，排了一次方案复评', async () => {
      const [plan] = await plansOf(f.clients.a1[0]);
      expect(plan).toMatchObject({
        status: 'active',
        artifact_id: seeded.a1!.plan,
        cycle_weeks: 8,
      });
      const days = (plan!.review_date.getTime() - plan!.start_date.getTime()) / 86_400_000;
      expect(days).toBe(56);
      const versions = (plan!.snapshot as { libraryVersions: { type: string }[] }).libraryVersions;
      expect(versions.map((v) => v.type).sort()).toEqual(['exercise', 'goal_template', 'recipe']);
      const review = await owner
        .selectFrom('visits')
        .select(['purpose', 'origin', 'status', 'care_plan_id', 'due_date'])
        .where('client_id', '=', f.clients.a1[0])
        .where('origin', '=', 'plan_review')
        .execute();
      expect(review).toHaveLength(1);
      expect(review[0]).toMatchObject({
        purpose: 'plan_review',
        status: 'planned',
        care_plan_id: plan!.id,
      });
      expect([1, 2, 3, 4, 5]).toContain(
        review[0]!.due_date.getUTCDay() === 0 ? 7 : review[0]!.due_date.getUTCDay(),
      );
    });

    it('新方案生效时旧方案标为已被替代，旧方案的复评随访也被替代；每位客户只有一份生效方案', async () => {
      const id = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
      await asA1((trx) => call(trx, 'approve_care_plan', id));
      const plans = await plansOf(f.clients.a1[0]);
      expect(plans.map((p) => p.status)).toEqual(['superseded', 'active']);
      const reviews = await owner
        .selectFrom('visits')
        .select(['status', 'care_plan_id'])
        .where('client_id', '=', f.clients.a1[0])
        .where('origin', '=', 'plan_review')
        .orderBy('created_at')
        .execute();
      expect(reviews.map((v) => v.status)).toEqual(['superseded', 'planned']);
    });

    it('引用的库条目未发布或不存在时拒绝确认（不写任何行）', async () => {
      for (const recipeId of [lib.draftRecipe, randomUUID()]) {
        const id = await draft(
          managerA1(),
          f.clients.a1[0],
          'care_plan',
          carePlanStructured({ recipes: [{ day: 1, meal: 'breakfast', recipeId }] }),
        );
        await expect(asA1((trx) => call(trx, 'approve_care_plan', id))).rejects.toMatchObject({
          code: '23514',
        });
      }
      expect((await plansOf(f.clients.a1[0])).map((p) => p.status)).toEqual(['active']);
    });

    it('应用只能把生效方案结束（原因必填），其他列和已结束的方案都改不了，也删不了', async () => {
      await expect(
        asA1((trx) => trx.updateTable('care_plans').set({ status: 'ended' }).execute()),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) => sql`update care_plans set cycle_weeks = 4`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
      const ended = await asA1((trx) =>
        trx
          .updateTable('care_plans')
          .set({ status: 'ended', end_reason: 'client_paused' })
          .returning(['ended_by', 'ended_at'])
          .executeTakeFirstOrThrow(),
      );
      expect(ended.ended_by).toBe(f.users.managerA1.id);
      await expect(
        asA1((trx) => trx.updateTable('care_plans').set({ end_reason: 'other' }).execute()),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(asA1((trx) => sql`delete from care_plans`.execute(trx))).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('随访（2.7）', () => {
    const manual = (clientId: string, over: Record<string, unknown> = {}) => ({
      client_id: clientId,
      due_date: futureDate(5),
      method: 'phone' as const,
      purpose: 'adhoc' as const,
      origin: 'manual' as const,
      created_by: f.users.managerA1.id,
      ...over,
    });

    it('手动加一次随访：只能给自己的客户，以本人名义；跟进项必须是同一位客户的', async () => {
      const added = await asA1((trx) =>
        trx
          .insertInto('visits')
          .values(manual(f.clients.a1[0]))
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      expect(added.id).toBeTruthy();
      for (const clientId of [f.clients.a2, f.clients.a3, f.clients.b1]) {
        await expect(
          asA1((trx) => trx.insertInto('visits').values(manual(clientId)).execute()),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        asA1((trx) =>
          trx
            .insertInto('visits')
            .values(manual(f.clients.a1[0], { created_by: f.users.managerA2.id }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const otherItem = await owner
        .insertInto('follow_up_items')
        .values({
          client_id: f.clients.a1[1],
          kind: 'status_worsened',
          severity: 3,
          domain: 'metabolic',
          dedupe_key: 'x',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(
        asA1((trx) =>
          trx
            .insertInto('visits')
            .values(manual(f.clients.a1[0], { follow_up_item_id: otherItem.id }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('随访计划确认：写入待随访；再次确认时旧计划未到期的随访被替代，手动加的和方案复评不受影响', async () => {
      const manualVisit = await asA1((trx) =>
        trx
          .insertInto('visits')
          .values(manual(f.clients.a1[0]))
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      const id = await draft(managerA1(), f.clients.a1[0], 'visit_schedule', {
        rows: [
          { dueDate: futureDate(14), method: 'wechat', purpose: 'routine', focus: '合成重点' },
          { dueDate: futureDate(28), method: 'phone', purpose: 'follow_up', focus: null },
        ],
      });
      expect(await asA1((trx) => call(trx, 'approve_visit_schedule', id))).toBe(2);
      const rows = await owner
        .selectFrom('visits')
        .select(['id', 'origin', 'status', 'source_artifact_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      const status = (pred: (r: (typeof rows)[number]) => boolean) =>
        rows
          .filter(pred)
          .map((r) => r.status)
          .sort();
      expect(status((r) => r.source_artifact_id === seeded.a1!.schedule)).toEqual(['superseded']);
      expect(status((r) => r.source_artifact_id === id)).toEqual(['planned', 'planned']);
      expect(status((r) => r.id === manualVisit.id)).toEqual(['planned']);
      expect(status((r) => r.origin === 'plan_review')).toEqual(['planned']);
    });

    it('随访计划：日期早于今天、超过 6 个月后、重复都被拒绝', async () => {
      for (const rows of [
        [{ dueDate: '2020-01-01', method: 'phone', purpose: 'routine', focus: null }],
        [{ dueDate: futureDate(200), method: 'phone', purpose: 'routine', focus: null }],
        [
          { dueDate: futureDate(3), method: 'phone', purpose: 'routine', focus: null },
          { dueDate: futureDate(3), method: 'phone', purpose: 'routine', focus: null },
        ],
        [{ dueDate: futureDate(3), method: 'fax', purpose: 'routine', focus: null }],
      ]) {
        const id = await draft(managerA1(), f.clients.a1[0], 'visit_schedule', { rows });
        await expect(asA1((trx) => call(trx, 'approve_visit_schedule', id))).rejects.toMatchObject({
          code: '23514',
        });
      }
    });

    it('随访计划里的方案复评：方案还没生效时“待方案生效”，方案确认后定日期，不重复排', async () => {
      const client = f.clients.a1[1];
      const schedule = await draft(managerA1(), client, 'visit_schedule', {
        rows: [
          {
            dueDate: futureDate(56),
            method: 'phone',
            purpose: 'plan_review',
            focus: '合成复评重点',
          },
        ],
      });
      await asA1((trx) => call(trx, 'approve_visit_schedule', schedule));
      const pending = await owner
        .selectFrom('visits')
        .select(['id', 'status'])
        .where('client_id', '=', client)
        .execute();
      expect(pending.map((v) => v.status)).toEqual(['pending_plan']);
      const plan = await draft(managerA1(), client, 'care_plan', carePlanStructured());
      await asA1((trx) => call(trx, 'approve_care_plan', plan));
      const after = await owner
        .selectFrom('visits')
        .select(['id', 'status', 'focus', 'care_plan_id'])
        .where('client_id', '=', client)
        .execute();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: pending[0]!.id,
        status: 'planned',
        focus: '合成复评重点',
      });
      expect(after[0]!.care_plan_id).toBeTruthy();
      const events = await owner
        .selectFrom('visit_events')
        .select('action')
        .where('visit_id', '=', after[0]!.id)
        .execute();
      expect(events.map((e) => e.action)).toEqual(['created', 'plan_activated']);
    });

    it('处理随访：完成要关联记录或备注；未联系上要改日期；系统状态和身份列改不了；记录不含备注', async () => {
      const v = await asA1((trx) =>
        trx
          .insertInto('visits')
          .values(manual(f.clients.a1[0]))
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      const upd = (set: Record<string, unknown>) =>
        asA1((trx) => trx.updateTable('visits').set(set).where('id', '=', v.id).execute());
      await expect(upd({ status: 'done' })).rejects.toMatchObject({ code: '23514' });
      await expect(upd({ status: 'missed' })).rejects.toMatchObject({ code: '23514' });
      await expect(upd({ status: 'superseded' })).rejects.toMatchObject({ code: '23514' });
      await expect(upd({ status: 'cancelled' })).rejects.toMatchObject({ code: '23514' });
      await expect(
        asA1((trx) => sql`update visits set origin = 'schedule' where id = ${v.id}`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
      await upd({ status: 'missed', due_date: futureDate(7) });
      await upd({ due_date: futureDate(9) });
      await upd({ status: 'done', note: '合成备注：已微信沟通' });
      await expect(upd({ status: 'planned' })).rejects.toMatchObject({ code: '23514' });
      const events = await asA1((trx) =>
        trx
          .selectFrom('visit_events')
          .selectAll()
          .where('visit_id', '=', v.id)
          .orderBy('id')
          .execute(),
      );
      expect(events.map((e) => e.action)).toEqual(['created', 'missed', 'rescheduled', 'done']);
      expect(JSON.stringify(events)).not.toContain('合成备注');
      // 完成关联的记录必须是同一位客户的
      const v2 = await asA1((trx) =>
        trx
          .insertInto('visits')
          .values(manual(f.clients.a1[0]))
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      const otherRecord = await draft(
        managerA1(),
        f.clients.a1[1],
        'visit_record',
        recordStructured(),
      );
      const otherRecordId = await asA1((trx) => call(trx, 'approve_visit_record', otherRecord));
      await expect(
        asA1((trx) =>
          trx
            .updateTable('visits')
            .set({ status: 'done', record_id: otherRecordId as string })
            .where('id', '=', v2.id)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('改不了、删不了别人的随访（查不到，0 行）', async () => {
      for (const c of [managerA2(), managerB1()]) {
        const r = await as(c, (trx) =>
          trx
            .updateTable('visits')
            .set({ status: 'cancelled', cancel_reason: 'other' })
            .where('client_id', '=', f.clients.a1[0])
            .executeTakeFirst(),
        );
        expect(r.numUpdatedRows).toBe(0n);
      }
      await expect(asA1((trx) => sql`delete from visits`.execute(trx))).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('素材、记录和补充说明（2.9）', () => {
    it('素材只给上传的健管师看；本人没勾选“已告知客户”不能上传', async () => {
      // 同机构健管师在自己客户上没勾选同意
      await expect(
        as(managerA2(), (trx) =>
          trx
            .insertInto('visit_materials')
            .values({
              client_id: f.clients.a1[1],
              kind: 'paste',
              text_encrypted: Buffer.from('x'),
              char_count: 1,
              uploaded_by: f.users.managerA2.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
      await expect(
        asA1((trx) =>
          trx
            .insertInto('visit_materials')
            .values({
              client_id: f.clients.a1[1],
              kind: 'paste',
              text_encrypted: Buffer.from('x'),
              char_count: 1,
              uploaded_by: f.users.managerA1.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // 别人名义的同意不行
      await expect(
        asA1((trx) =>
          trx
            .insertInto('client_record_consents')
            .values({
              client_id: f.clients.a1[1],
              kind: 'visit_material',
              confirmed_by: f.users.managerA2.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('确认记录：写入记录，关联的随访完成，素材记下产物并在 30 天后删除；勾选的跟进项一并处理', async () => {
      const item = await owner
        .insertInto('follow_up_items')
        .values({
          client_id: f.clients.a1[0],
          kind: 'status_worsened',
          severity: 3,
          domain: 'metabolic',
          dedupe_key: 'k1',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const visit = await owner
        .selectFrom('visits')
        .select('id')
        .where('client_id', '=', f.clients.a1[0])
        .where('origin', '=', 'schedule')
        .executeTakeFirstOrThrow();
      const id = await draft(managerA1(), f.clients.a1[0], 'visit_record', recordStructured(), {
        visit_id: visit.id,
      });
      const recordId = await asA1((trx) =>
        sql<{ r: string }>`select approve_visit_record(${id}, ${[item.id]}::uuid[]) as r`.execute(
          trx,
        ),
      ).then((x) => x.rows[0]!.r);
      expect(
        await owner
          .selectFrom('visits')
          .select(['status', 'record_id'])
          .where('id', '=', visit.id)
          .executeTakeFirst(),
      ).toEqual({ status: 'done', record_id: recordId });
      expect(
        await owner
          .selectFrom('follow_up_items')
          .select(['status', 'resolution', 'resolved_by'])
          .where('id', '=', item.id)
          .executeTakeFirst(),
      ).toEqual({ status: 'done', resolution: 'called', resolved_by: f.users.managerA1.id });
      const material = await owner
        .selectFrom('visit_materials')
        .select(['consumed_artifact_id', 'purge_after'])
        .where('id', '=', seeded.a1!.material)
        .executeTakeFirstOrThrow();
      expect(material.consumed_artifact_id).toBe(seeded.a1!.record);
      expect(material.purge_after.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    });

    it('勾选了别的客户或别人的跟进项：整个事务回滚，记录不写', async () => {
      const others = [
        await owner
          .insertInto('follow_up_items')
          .values({
            client_id: f.clients.a1[1],
            kind: 'status_worsened',
            severity: 3,
            domain: 'metabolic',
            dedupe_key: 'k2',
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
        await owner
          .insertInto('follow_up_items')
          .values({
            client_id: f.clients.b1,
            kind: 'status_worsened',
            severity: 3,
            domain: 'metabolic',
            dedupe_key: 'k3',
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      ];
      for (const other of others) {
        const id = await draft(managerA1(), f.clients.a1[0], 'visit_record', recordStructured());
        await expect(
          asA1((trx) =>
            sql`select approve_visit_record(${id}, ${[other.id]}::uuid[])`.execute(trx),
          ),
        ).rejects.toMatchObject({ code: 'P0002' });
        expect(
          await owner
            .selectFrom('visit_records')
            .select('id')
            .where('artifact_id', '=', id)
            .execute(),
        ).toHaveLength(0);
        expect(
          (
            await owner
              .selectFrom('artifacts')
              .select('status')
              .where('id', '=', id)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('draft');
        expect(
          (
            await owner
              .selectFrom('follow_up_items')
              .select('status')
              .where('id', '=', other.id)
              .executeTakeFirstOrThrow()
          ).status,
        ).toBe('open');
      }
    });

    it('记录缺日期或方式不能确认；产物的素材必须是本人上传的同一位客户的', async () => {
      const id = await draft(
        managerA1(),
        f.clients.a1[0],
        'visit_record',
        recordStructured({ visitDate: null }),
      );
      await expect(asA1((trx) => call(trx, 'approve_visit_record', id))).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        draft(managerA1(), f.clients.a1[1], 'visit_record', recordStructured(), {
          material_ids: [seeded.a1!.material],
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        draft(managerA1(), f.clients.a1[0], 'visit_record', recordStructured(), {
          material_ids: [seeded.a2!.material],
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('记录、补充说明、同意只能追加：直接修改或删除被拒绝；补充说明只能以本人名义', async () => {
      for (const stmt of [
        sql`update visit_records set method = 'wechat'`,
        sql`delete from visit_records`,
        sql`update visit_record_addenda set text = 'x'`,
        sql`delete from visit_record_addenda`,
        sql`update client_record_consents set kind = 'visit_material'`,
        sql`delete from visit_events`,
      ]) {
        await expect(asA1((trx) => stmt.execute(trx))).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        asA1((trx) =>
          trx
            .insertInto('visit_record_addenda')
            .values({
              client_id: f.clients.a1[0],
              record_id: seeded.a1!.recordId,
              text: 'x',
              created_by: f.users.managerA2.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // 补充说明不能挂到别人的记录上
      await expect(
        asA1((trx) =>
          trx
            .insertInto('visit_record_addenda')
            .values({
              client_id: f.clients.a2,
              record_id: seeded.a2!.recordId,
              text: 'x',
              created_by: f.users.managerA1.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('素材只能删除自己的；清理任务只能在没有租户上下文时调用，到期的原文被删除', async () => {
      const r = await as(managerA2(), (trx) =>
        trx.deleteFrom('visit_materials').where('id', '=', seeded.a1!.material).executeTakeFirst(),
      );
      expect(r.numDeletedRows).toBe(0n);
      await expect(
        asA1((trx) => sql`select visit_materials_purge_due()`.execute(trx)),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await owner
        .updateTable('visit_materials')
        .set({ purge_after: new Date(Date.now() - 1000) })
        .where('id', '=', seeded.a1!.material)
        .execute();
      const n = await sql<{ n: number }>`select visit_materials_purge_due() as n`.execute(app);
      expect(n.rows[0]!.n).toBe(1);
      const m = await owner
        .selectFrom('visit_materials')
        .select(['text_encrypted', 'purged_at'])
        .where('id', '=', seeded.a1!.material)
        .executeTakeFirstOrThrow();
      expect(m.text_encrypted).toBeNull();
      expect(m.purged_at).not.toBeNull();
    });
  });

  describe('消息和产物的引用', () => {
    it('消息 @ 的素材必须是任务客户的、本人上传的；@ 的库条目必须已发布', async () => {
      const send = (clientId: string, over: Record<string, unknown>) =>
        asA1(async (trx) => {
          const task = await trx
            .insertInto('tasks')
            .values({
              operator_id: f.operatorA,
              org_id: f.orgA,
              manager_id: f.users.managerA1.id,
              client_id: clientId,
              title: 't',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('task_messages')
            .values({
              operator_id: f.operatorA,
              org_id: f.orgA,
              manager_id: f.users.managerA1.id,
              task_id: task.id,
              role: 'manager',
              mode: 'craft',
              status: 'complete',
              ...over,
            })
            .execute();
        });
      await send(f.clients.a1[0], { material_refs: [seeded.a1!.material] });
      await expect(
        send(f.clients.a1[1], { material_refs: [seeded.a1!.material] }),
      ).rejects.toMatchObject({
        code: '23514',
      });
      await expect(
        send(f.clients.a1[0], { material_refs: [seeded.b1!.material] }),
      ).rejects.toMatchObject({
        code: '23514',
      });
      await send(f.clients.a1[0], {
        library_refs: JSON.stringify([{ type: 'recipe', id: lib.recipe }]),
      });
      for (const ref of [
        { type: 'recipe', id: lib.draftRecipe },
        { type: 'goal_template', id: lib.goal },
        { type: 'recipe', id: 'not-a-uuid' },
      ]) {
        await expect(
          send(f.clients.a1[0], { library_refs: JSON.stringify([ref]) }),
        ).rejects.toMatchObject({
          code: '23514',
        });
      }
    });

    it('方案选项只有方案草稿有；生成后不能改；已审核的结构化内容不能改', async () => {
      await expect(
        draft(managerA1(), f.clients.a1[0], 'visit_record', recordStructured(), {
          plan_options: JSON.stringify({ sections: ['diet'], cycleWeeks: 8 }),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      const id = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
      await expect(
        asA1((trx) =>
          sql`update artifacts set plan_options = '{"sections":["diet"],"cycleWeeks":4}' where id = ${id}`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ structured: JSON.stringify(carePlanStructured({ recipes: [] })) })
          .where('id', '=', id)
          .execute(),
      );
      await expect(
        asA1((trx) =>
          trx
            .updateTable('artifacts')
            .set({ structured: '{}' })
            .where('id', '=', seeded.a1!.plan)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('客户转出、调机构和删除（Q30）', () => {
    it('客户转给同机构的健管师：方案、随访、记录跟着转；原健管师看不到；素材原文删除且新健管师也看不到', async () => {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      expect(await clientIdsSeenBy(managerA1())).toEqual(each([]));
      const a2 = await clientIdsSeenBy(managerA2());
      for (const t of [
        'care_plans',
        'visits',
        'visit_records',
        'visit_record_addenda',
        'visit_events',
        'client_record_consents',
      ]) {
        expect(a2[t], t).toContain(f.clients.a1[0]);
      }
      expect(a2.visit_materials).not.toContain(f.clients.a1[0]);
      const m = await owner
        .selectFrom('visit_materials')
        .select(['text_encrypted', 'consumed_artifact_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(m).toEqual([{ text_encrypted: null, consumed_artifact_id: null }]);
      // 方案快照保留，对原健管师产物的引用置空；产物按 M1 作废、和客户断开
      const plan = await owner
        .selectFrom('care_plans')
        .select(['artifact_id', 'status', 'manager_id'])
        .where('client_id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow();
      expect(plan).toEqual({
        artifact_id: null,
        status: 'active',
        manager_id: f.users.managerA2.id,
      });
      const art = await owner
        .selectFrom('artifacts')
        .select(['client_id', 'visit_id', 'material_ids'])
        .where('id', '=', seeded.a1!.record)
        .executeTakeFirstOrThrow();
      expect(art).toEqual({ client_id: null, visit_id: null, material_ids: null });
      // 新健管师可以继续处理转来的随访，需要自己勾选同意后才能上传素材
      const r = await as(managerA2(), (trx) =>
        trx
          .updateTable('visits')
          .set({ status: 'cancelled', cancel_reason: 'other' })
          .where('client_id', '=', f.clients.a1[0])
          .where('status', '=', 'planned')
          .executeTakeFirst(),
      );
      expect(r.numUpdatedRows).toBeGreaterThan(0n);
      await expect(
        as(managerA2(), (trx) =>
          trx
            .insertInto('visit_materials')
            .values({
              client_id: f.clients.a1[0],
              kind: 'paste',
              text_encrypted: Buffer.from('x'),
              char_count: 1,
              uploaded_by: f.users.managerA2.id,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('客户转到别的机构、健管师调机构：新表的 org_id 跟着变', async () => {
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
        .where('id', '=', f.clients.a1[0])
        .execute();
      for (const table of CLIENT_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select(['manager_id', 'org_id'])
          .where('client_id', '=', f.clients.a1[0])
          .execute();
        expect(rows.length, table).toBeGreaterThan(0);
        for (const row of rows)
          expect(row, table).toEqual({ manager_id: f.users.managerA3.id, org_id: f.orgA2 });
      }
      await owner
        .updateTable('users')
        .set({ org_id: f.orgA })
        .where('id', '=', f.users.managerA3.id)
        .execute();
      for (const table of CLIENT_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select('org_id')
          .where('manager_id', '=', f.users.managerA3.id)
          .execute();
        expect(new Set(rows.map((r) => r.org_id)), table).toEqual(new Set([f.orgA]));
      }
    });

    it('客户删除时方案和随访数据一起删除（包括只能追加的记录）', async () => {
      await asA1((trx) => trx.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute());
      for (const table of CLIENT_TABLES) {
        const rows = await owner
          .selectFrom(table)
          .select('client_id')
          .where('client_id', '=', f.clients.a1[0])
          .execute();
        expect(rows, table).toHaveLength(0);
      }
    });
  });

  describe('方案库（2.4、Q11）', () => {
    const asPlatform = <T>(fn: (trx: TenantTransaction) => Promise<T>) => as(platform(), fn);
    const newRecipe = (over: Record<string, unknown> = {}) => ({
      code: 'new-dish',
      name: '合成新菜',
      meal_types: ['lunch'],
      ingredients: JSON.stringify([{ name: '青菜', householdAmount: '一把' }]),
      steps: JSON.stringify(['清炒']),
      allergens: [],
      source_note: '合成',
      updated_by: f.users.platform.id,
      ...over,
    });

    it('健管师、机构管理员、运营商只看到已发布的；预览开关打开时含待审定；平台看到全部', async () => {
      await owner
        .updateTable('plan_library_recipes')
        .set({ status: 'review' })
        .where('id', '=', lib.draftRecipe)
        .execute();
      for (const c of [managerA1(), orgAdminA(), operatorAdminA()]) {
        const ids = await as(c, (trx) =>
          trx.selectFrom('plan_library_recipes').select('id').execute(),
        );
        expect(ids.map((r) => r.id).sort(), c.role).toEqual(
          [lib.recipe, lib.allergenRecipe].sort(),
        );
        const preview = await as(c, async (trx) => {
          await sql`select set_config('hb.plan_library_preview', 'on', true)`.execute(trx);
          return trx.selectFrom('plan_library_recipes').select('id').execute();
        });
        expect(preview, c.role).toHaveLength(3);
      }
      expect(
        await asPlatform((trx) => trx.selectFrom('plan_library_recipes').select('id').execute()),
      ).toHaveLength(3);
    });

    it('只有平台管理员能新增和修改；新增只能是草稿；没有删除权限；修改记录只有平台能看', async () => {
      for (const c of [managerA1(), orgAdminA(), operatorAdminA()]) {
        await expect(
          as(c, (trx) =>
            trx
              .insertInto('plan_library_recipes')
              .values(newRecipe({ updated_by: c.userId }))
              .execute(),
          ),
          c.role,
        ).rejects.toMatchObject({ code: '42501' });
        const r = await as(c, (trx) =>
          trx
            .updateTable('plan_library_recipes')
            .set({ status: 'retired', updated_by: c.userId })
            .executeTakeFirst(),
        );
        expect(r.numUpdatedRows, c.role).toBe(0n);
        expect(
          await as(c, (trx) => trx.selectFrom('plan_library_events').select('id').execute()),
          c.role,
        ).toHaveLength(0);
      }
      await expect(
        asPlatform((trx) =>
          trx
            .insertInto('plan_library_recipes')
            .values(newRecipe({ status: 'published' }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await asPlatform((trx) =>
        trx.insertInto('plan_library_recipes').values(newRecipe()).execute(),
      );
      await expect(
        asPlatform((trx) => sql`delete from plan_library_recipes`.execute(trx)),
      ).rejects.toMatchObject({
        code: '42501',
      });
      const events = await asPlatform((trx) =>
        trx
          .selectFrom('plan_library_events')
          .selectAll()
          .where('actor_id', '=', f.users.platform.id)
          .execute(),
      );
      expect(events.map((e) => e.action)).toEqual(['created']);
    });

    it('内容只能在草稿时改，改了版本号加一；发布要审定人；状态按顺序流转；不能以别人名义', async () => {
      const id = (
        await asPlatform((trx) =>
          trx
            .insertInto('plan_library_recipes')
            .values(newRecipe())
            .returning('id')
            .executeTakeFirstOrThrow(),
        )
      ).id;
      const upd = (set: Record<string, unknown>) =>
        asPlatform((trx) =>
          trx
            .updateTable('plan_library_recipes')
            .set({ updated_by: f.users.platform.id, ...set })
            .where('id', '=', id)
            .returning(['version', 'status'])
            .executeTakeFirstOrThrow(),
        );
      expect(await upd({ name: '合成新菜二' })).toEqual({ version: 2, status: 'draft' });
      await expect(upd({ status: 'published' })).rejects.toMatchObject({ code: '23514' });
      await upd({ status: 'review' });
      await expect(upd({ name: '待审定时改' })).rejects.toMatchObject({ code: '23514' });
      await expect(upd({ status: 'published' })).rejects.toMatchObject({ code: '23514' });
      expect(
        await upd({
          status: 'published',
          reviewed_by_label: '合成顾问',
          reviewed_on: '2026-10-26',
        }),
      ).toEqual({
        version: 2,
        status: 'published',
      });
      await expect(upd({ name: '已发布时改' })).rejects.toMatchObject({ code: '23514' });
      await expect(
        upd({ updated_by: f.users.managerA1.id, status: 'retired' }),
      ).rejects.toMatchObject({ code: '23514' });
      await upd({ status: 'retired' });
      await expect(upd({ status: 'published' })).rejects.toMatchObject({ code: '23514' });
      await expect(
        asPlatform((trx) =>
          sql`update plan_library_recipes set code = 'x-code' where id = ${id}`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const events = await owner
        .selectFrom('plan_library_events')
        .select('action')
        .where('item_id', '=', id)
        .orderBy('id')
        .execute();
      expect(events.map((e) => e.action)).toEqual([
        'created',
        'updated',
        'status_changed',
        'status_changed',
        'status_changed',
      ]);
    });

    it('过敏原必须显式填写，标签只能从固定标签表里选', async () => {
      await expect(
        asPlatform((trx) =>
          trx
            .insertInto('plan_library_recipes')
            .values(newRecipe({ allergens: ['mango'] }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asPlatform((trx) =>
          trx
            .insertInto('plan_library_recipes')
            .values(newRecipe({ tags: ['适合糖尿病'] }))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        asPlatform((trx) =>
          sql`insert into plan_library_recipes (code, name, meal_types, ingredients, steps, source_note, updated_by)
          values ('x-dish', 'x', '{lunch}', '[{}]', '["a"]', 's', ${f.users.platform.id})`.execute(
            trx,
          ),
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  describe('随访频次规则（Q18）', () => {
    const version = async () =>
      (
        await owner
          .selectFrom('visit_frequency_version')
          .select('version')
          .executeTakeFirstOrThrow()
      ).version;

    it('所有登录角色都能读；只有平台管理员能改，同一事务只加一次版本号，记录改前改后', async () => {
      for (const c of [managerA1(), orgAdminA(), operatorAdminA(), platform()]) {
        const rows = await as(c, (trx) =>
          trx.selectFrom('visit_frequency_rules').select('risk_tier').execute(),
        );
        expect(rows, c.role).toHaveLength(4);
      }
      for (const c of [managerA1(), orgAdminA(), operatorAdminA()]) {
        const r = await as(c, (trx) =>
          trx
            .updateTable('visit_frequency_rules')
            .set({ interval_days: 20, updated_by: c.userId })
            .executeTakeFirst(),
        );
        expect(r.numUpdatedRows, c.role).toBe(0n);
      }
      expect(await version()).toBe(1);
      await as(platform(), async (trx) => {
        await trx
          .updateTable('visit_frequency_rules')
          .set({ interval_days: 21, updated_by: f.users.platform.id })
          .where('risk_tier', 'in', ['high', 'medium'])
          .execute();
        await trx
          .updateTable('visit_frequency_config')
          .set({ first_visit_within_days: 2, updated_by: f.users.platform.id })
          .execute();
      });
      expect(await version()).toBe(2);
      const events = await as(platform(), (trx) =>
        trx.selectFrom('visit_frequency_rule_events').selectAll().execute(),
      );
      expect(events).toHaveLength(3);
      expect(new Set(events.map((e) => e.rules_version))).toEqual(new Set([2]));
      expect(new Set(events.map((e) => e.actor_id))).toEqual(new Set([f.users.platform.id]));
    });

    it('超出范围被拒绝；不能新增或删除分层；不能以别人的名义修改', async () => {
      await expect(
        as(platform(), (trx) =>
          trx
            .updateTable('visit_frequency_rules')
            .set({ interval_days: 3, updated_by: f.users.platform.id })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        as(platform(), (trx) =>
          trx
            .updateTable('visit_frequency_config')
            .set({ first_visit_within_days: 30, updated_by: f.users.platform.id })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        as(platform(), (trx) =>
          sql`insert into visit_frequency_rules values ('x', 10, 'phone')`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        as(platform(), (trx) => sql`delete from visit_frequency_rules`.execute(trx)),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        as(platform(), (trx) =>
          trx
            .updateTable('visit_frequency_rules')
            .set({ interval_days: 20, updated_by: f.users.managerA1.id })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('确认函数的并发、权限和转出（评审补充）', () => {
    /** 单独的连接，开事务并设置租户上下文（和 withTenant 一样只在本事务内有效） */
    async function openTx(c: TenantContext) {
      const conn = new pg.Client({ connectionString: TEST_APP_URL });
      await conn.connect();
      await conn.query('begin');
      await conn.query(
        `select set_config('app.user_id', $1, true), set_config('app.role', $2, true),
                set_config('app.operator_id', $3, true), set_config('app.org_id', $4, true)`,
        [c.userId, c.role, c.operatorId ?? '', c.orgId ?? ''],
      );
      return conn;
    }

    it('同一位客户的两次随访计划确认串行：后一个等前一个提交，再把前一个的随访替代', async () => {
      const client = f.clients.a1[0];
      const schedA = await draft(managerA1(), client, 'visit_schedule', {
        rows: [{ dueDate: futureDate(12), method: 'phone', purpose: 'routine', focus: null }],
      });
      const schedB = await draft(managerA1(), client, 'visit_schedule', {
        rows: [{ dueDate: futureDate(15), method: 'wechat', purpose: 'routine', focus: null }],
      });
      const c1 = await openTx(managerA1());
      const c2 = await openTx(managerA1());
      try {
        await c1.query('select approve_visit_schedule($1)', [schedA]);
        let settled = false;
        const second = c2.query('select approve_visit_schedule($1)', [schedB]).finally(() => {
          settled = true;
        });
        await new Promise((r) => setTimeout(r, 300));
        // 第二个连接还在等客户行锁
        expect(settled).toBe(false);
        await c1.query('commit');
        await second;
        await c2.query('commit');
      } finally {
        await c1.end();
        await c2.end();
      }
      const rows = await owner
        .selectFrom('visits')
        .select(['status', 'source_artifact_id'])
        .where('client_id', '=', client)
        .where('source_artifact_id', 'in', [schedA, schedB])
        .execute();
      expect(rows.filter((r) => r.source_artifact_id === schedA).map((r) => r.status)).toEqual([
        'superseded',
      ]);
      expect(rows.filter((r) => r.source_artifact_id === schedB).map((r) => r.status)).toEqual([
        'planned',
      ]);
    });

    it('随访计划和随访记录的确认函数：同机构、协会B的健管师按不存在处理，不写任何行', async () => {
      const visitsBefore = await owner.selectFrom('visits').select('id').execute();
      const recordsBefore = await owner.selectFrom('visit_records').select('id').execute();
      for (const c of [managerA2(), managerB1()]) {
        const schedule = await draft(managerA1(), f.clients.a1[0], 'visit_schedule', {
          rows: [{ dueDate: futureDate(20), method: 'phone', purpose: 'routine', focus: null }],
        });
        const record = await draft(
          managerA1(),
          f.clients.a1[0],
          'visit_record',
          recordStructured(),
        );
        await expect(
          as(c, (trx) => call(trx, 'approve_visit_schedule', schedule)),
        ).rejects.toMatchObject({ code: 'P0002' });
        await expect(
          as(c, (trx) => call(trx, 'approve_visit_record', record)),
        ).rejects.toMatchObject({ code: 'P0002' });
        const statuses = await owner
          .selectFrom('artifacts')
          .select('status')
          .where('id', 'in', [schedule, record])
          .execute();
        expect(statuses.map((r) => r.status)).toEqual(['draft', 'draft']);
      }
      expect(await owner.selectFrom('visits').select('id').execute()).toHaveLength(
        visitsBefore.length,
      );
      expect(await owner.selectFrom('visit_records').select('id').execute()).toHaveLength(
        recordsBefore.length,
      );
    });

    it('内部函数不给应用角色执行权限', async () => {
      const draftId = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
      const calls = [
        sql`select m5_lock_draft(${draftId}::uuid, 'care_plan')`,
        sql`select m5_default_visit_method(${f.clients.a1[0]}::uuid)`,
        sql`select hb_user_today()`,
      ];
      for (const stmt of calls) {
        await expect(asA1((trx) => stmt.execute(trx))).rejects.toMatchObject({ code: '42501' });
      }
      const row = await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', draftId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('draft');
    });

    it('客户转出后，原健管师不能确认转出前的草稿；新健管师也确认不了', async () => {
      const plan = await draft(managerA1(), f.clients.a1[0], 'care_plan', carePlanStructured());
      const schedule = await draft(managerA1(), f.clients.a1[0], 'visit_schedule', {
        rows: [{ dueDate: futureDate(20), method: 'phone', purpose: 'routine', focus: null }],
      });
      const record = await draft(managerA1(), f.clients.a1[0], 'visit_record', recordStructured());
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      for (const c of [managerA1(), managerA2()]) {
        for (const [fn, id] of [
          ['approve_care_plan', plan],
          ['approve_visit_schedule', schedule],
          ['approve_visit_record', record],
        ] as const) {
          await expect(
            as(c, (trx) => call(trx, fn, id)),
            `${c.userId} ${fn}`,
          ).rejects.toMatchObject({ code: 'P0002' });
        }
      }
      const plans = await owner
        .selectFrom('care_plans')
        .select('status')
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(plans.map((p) => p.status)).toEqual(['active']);
    });

    it('消息引用的素材被删除后，这条消息的内容和状态仍然可以更新', async () => {
      const messageId = await asA1(async (trx) => {
        const task = await trx
          .insertInto('tasks')
          .values({
            operator_id: f.operatorA,
            org_id: f.orgA,
            manager_id: f.users.managerA1.id,
            client_id: f.clients.a1[0],
            title: 't',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return (
          await trx
            .insertInto('task_messages')
            .values({
              operator_id: f.operatorA,
              org_id: f.orgA,
              manager_id: f.users.managerA1.id,
              task_id: task.id,
              role: 'manager',
              mode: 'craft',
              status: 'streaming',
              material_refs: [seeded.a1!.material],
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      });
      const deleted = await asA1((trx) =>
        trx.deleteFrom('visit_materials').where('id', '=', seeded.a1!.material).executeTakeFirst(),
      );
      expect(deleted.numDeletedRows).toBe(1n);
      const updated = await asA1((trx) =>
        trx
          .updateTable('task_messages')
          .set({ status: 'complete', content: '合成回复' })
          .where('id', '=', messageId)
          .executeTakeFirst(),
      );
      expect(updated.numUpdatedRows).toBe(1n);
      // 引用本身不能由应用改（列权限），写入后只能更新内容和状态
      await expect(
        asA1((trx) =>
          trx
            .updateTable('task_messages')
            .set({ material_refs: [seeded.b1!.material] })
            .where('id', '=', messageId)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
