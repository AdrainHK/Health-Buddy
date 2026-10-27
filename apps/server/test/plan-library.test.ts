import type { INestApplication } from '@nestjs/common';
import { loadPlanLibrarySeed } from '@health-buddy/plan-library';
import {
  adminExerciseListResponseSchema,
  adminRecipeListResponseSchema,
  adminRecipeResponseSchema,
  exerciseDetailResponseSchema,
  exerciseListResponseSchema,
  goalTemplateListResponseSchema,
  libraryContentRejectionSchema,
  libraryItemEventListResponseSchema,
  recipeDetailResponseSchema,
  recipeListResponseSchema,
  visitFrequencyRuleEventListResponseSchema,
  visitFrequencyRulesResponseSchema,
  DEFAULT_VISIT_FREQUENCY_RULES,
  type RecipeContent,
} from '@health-buddy/shared';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importPlanLibrarySeed } from '../src/db/plan-library-seed.js';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

/**
 * M5 第 2 步：方案库和随访频次规则的接口（规格 2.4、2.12、6.4）。
 * 方案库是平台级数据，不含客户数据；“跨租户”在这里体现为按角色拒绝：非平台管理员改库 → 403，
 * 健管师和后台角色只能看到已发布的条目（预览环境含待审定）。全部是合成数据。
 */
describe('方案库和随访频次规则接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let preview: INestApplication;
  let f: Fixtures;

  const as = (u: Account, a: INestApplication = app) => loginAs(a, u.email);
  const seed = loadPlanLibrarySeed();

  const newRecipe = (over: Partial<RecipeContent> = {}): RecipeContent => ({
    code: 'test-veg-soup',
    name: '合成青菜汤',
    mealTypes: ['lunch', 'dinner'],
    ingredients: [
      { name: '小青菜', householdAmount: '两三棵', grams: null, overseasAlternative: '菠菜' },
    ],
    steps: ['水开后放青菜', '加少许盐'],
    nutritionPerServing: null,
    nutritionBasis: null,
    tags: ['vegetable_rich', 'quick'],
    allergens: [],
    sourceNote: '合成测试条目',
    ...over,
  });

  async function seedId(table: 'plan_library_recipes' | 'plan_library_exercises', code: string) {
    return (
      await owner.selectFrom(table).select('id').where('code', '=', code).executeTakeFirstOrThrow()
    ).id as string;
  }

  beforeAll(async () => {
    f = await seedFixtures(owner);
    // seedFixtures 清空了用户（库条目跟着级联清空），按部署时的做法重新导入种子
    await importPlanLibrarySeed(owner);
    app = await createTestApp();
    preview = await createTestApp({ planLibraryPreview: true });
  });

  afterAll(async () => {
    await app.close();
    await preview.close();
    await owner.destroy();
  });

  describe('种子导入', () => {
    it('导入的条目都是待审定；重复导入不新增也不覆盖已有的条目', async () => {
      const counts = await owner
        .selectFrom('plan_library_recipes')
        .select(['status', sql<number>`count(*)::int`.as('n')])
        .groupBy('status')
        .execute();
      expect(counts).toEqual([{ status: 'review', n: seed.recipes.length }]);

      const id = await seedId('plan_library_recipes', seed.recipes[0]!.code);
      await owner
        .updateTable('plan_library_recipes')
        .set({ name: '平台改过的名字' })
        .where('id', '=', id)
        .execute();
      expect(await importPlanLibrarySeed(owner)).toEqual({
        recipes: 0,
        exercises: 0,
        goalTemplates: 0,
      });
      const row = await owner
        .selectFrom('plan_library_recipes')
        .select('name')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('平台改过的名字');
      await owner
        .updateTable('plan_library_recipes')
        .set({ name: seed.recipes[0]!.name })
        .where('id', '=', id)
        .execute();
    });
  });

  describe('浏览（GET /api/plan-library/:type）', () => {
    it('无登录 → 401；未知的库 → 404', async () => {
      await request(app.getHttpServer()).get('/api/plan-library/recipes').expect(401);
      const agent = await as(f.users.managerA1);
      await agent.get('/api/plan-library/videos').expect(404);
    });

    it('正式环境看不到待审定的种子条目；预览环境能看到', async () => {
      for (const u of [
        f.users.managerA1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const prod = recipeListResponseSchema.parse(
          (await (await as(u)).get('/api/plan-library/recipes').expect(200)).body,
        );
        expect(prod.items, u.email).toEqual([]);
        const pre = recipeListResponseSchema.parse(
          (await (await as(u, preview)).get('/api/plan-library/recipes').expect(200)).body,
        );
        expect(pre.items, u.email).toHaveLength(seed.recipes.length);
      }
    });

    it('按餐次、标签、名称和类别筛选', async () => {
      const agent = await as(f.users.managerA1, preview);
      const breakfast = recipeListResponseSchema.parse(
        (await agent.get('/api/plan-library/recipes?meal=breakfast').expect(200)).body,
      );
      expect(breakfast.items.length).toBeGreaterThanOrEqual(15);
      expect(breakfast.items.every((r) => r.mealTypes.includes('breakfast'))).toBe(true);

      const tagged = recipeListResponseSchema.parse(
        (await agent.get('/api/plan-library/recipes?tags=vegetarian&tags=quick').expect(200)).body,
      );
      expect(tagged.items.length).toBeGreaterThan(0);
      for (const r of tagged.items)
        expect(r.tags).toEqual(expect.arrayContaining(['vegetarian', 'quick']));

      const byName = recipeListResponseSchema.parse(
        (await agent.get(`/api/plan-library/recipes?q=${encodeURIComponent('番茄')}`).expect(200))
          .body,
      );
      expect(byName.items.length).toBeGreaterThan(0);
      expect(byName.items.every((r) => r.name.includes('番茄'))).toBe(true);
      // 通配符按字面匹配
      const wildcard = recipeListResponseSchema.parse(
        (await agent.get('/api/plan-library/recipes?q=%25').expect(200)).body,
      );
      expect(wildcard.items).toEqual([]);

      const relax = exerciseListResponseSchema.parse(
        (await agent.get('/api/plan-library/exercises?category=relaxation').expect(200)).body,
      );
      expect(relax.items.length).toBeGreaterThanOrEqual(5);
      expect(relax.items.every((e) => e.category === 'relaxation')).toBe(true);

      const routine = goalTemplateListResponseSchema.parse(
        (await agent.get('/api/plan-library/goal-templates?section=routine').expect(200)).body,
      );
      expect(routine.items.length).toBeGreaterThan(3);
      expect(routine.items.every((g) => g.section === 'routine')).toBe(true);

      await agent.get('/api/plan-library/recipes?meal=brunch').expect(400);
      await agent.get('/api/plan-library/recipes?tags=fit_for_diabetes').expect(400);
    });

    it('健管师的响应不含状态和审定信息；运动条目含给健管师看的注意事项', async () => {
      const agent = await as(f.users.managerA1, preview);
      const id = await seedId('plan_library_exercises', 'aerobic-brisk-walk');
      const res = await agent.get(`/api/plan-library/exercises/${id}`).expect(200);
      const { item } = exerciseDetailResponseSchema.parse(res.body);
      expect(item.managerCautions.length).toBeGreaterThan(5);
      expect(res.body.item).not.toHaveProperty('status');
      expect(res.body.item).not.toHaveProperty('reviewedByLabel');
      expect(res.body.item).not.toHaveProperty('updatedByName');
      // 正式环境：待审定 → 404
      await (await as(f.users.managerA1)).get(`/api/plan-library/exercises/${id}`).expect(404);
      await agent.get('/api/plan-library/exercises/not-a-uuid').expect(404);
      // 类型和 id 对不上 → 404
      await agent.get(`/api/plan-library/recipes/${id}`).expect(404);
    });

    it('预览开关只放行待审定，不放行草稿和已停用', async () => {
      const draftId = await seedId('plan_library_exercises', 'balance-weight-shift');
      const retiredId = await seedId('plan_library_exercises', 'balance-side-leg-raise');
      await owner
        .updateTable('plan_library_exercises')
        .set({ status: 'draft' })
        .where('id', '=', draftId)
        .execute();
      await owner
        .updateTable('plan_library_exercises')
        .set({ status: 'retired' })
        .where('id', '=', retiredId)
        .execute();
      for (const u of [f.users.managerA1, f.users.orgAdminA, f.users.operatorAdminA]) {
        const agent = await as(u, preview);
        const ids = exerciseListResponseSchema
          .parse((await agent.get('/api/plan-library/exercises').expect(200)).body)
          .items.map((e) => e.id);
        expect(ids, u.email).not.toContain(draftId);
        expect(ids, u.email).not.toContain(retiredId);
        await agent.get(`/api/plan-library/exercises/${draftId}`).expect(404);
        await agent.get(`/api/plan-library/exercises/${retiredId}`).expect(404);
        if (u.email !== f.users.managerA1.email) {
          const admin = adminExerciseListResponseSchema
            .parse((await agent.get('/api/admin/plan-library/exercises').expect(200)).body)
            .items.map((e) => e.id);
          expect(admin, u.email).not.toContain(draftId);
          expect(admin, u.email).not.toContain(retiredId);
        }
      }
      await owner
        .updateTable('plan_library_exercises')
        .set({ status: 'review' })
        .where('id', 'in', [draftId, retiredId])
        .execute();
    });
  });

  describe('后台维护（只有平台管理员）', () => {
    it('运营商、机构管理员、健管师改库 → 403，且不改任何行', async () => {
      const id = await seedId('plan_library_recipes', seed.recipes[0]!.code);
      const before = await owner.selectFrom('plan_library_recipes').selectAll().execute();
      for (const u of [f.users.operatorAdminA, f.users.orgAdminA, f.users.managerA1]) {
        const agent = await as(u, preview);
        await agent.post('/api/admin/plan-library/recipes').send(newRecipe()).expect(403);
        await agent
          .patch(`/api/admin/plan-library/recipes/${id}`)
          .send({ version: 1, content: newRecipe() })
          .expect(403);
        await agent
          .post(`/api/admin/plan-library/recipes/${id}/status`)
          .send({ version: 1, status: 'published', reviewedByLabel: 'x', reviewedOn: '2026-10-01' })
          .expect(403);
        await agent.get(`/api/admin/plan-library/recipes/${id}/events`).expect(403);
      }
      expect(await owner.selectFrom('plan_library_recipes').selectAll().execute()).toEqual(before);
      await (await as(f.users.managerA1)).get('/api/admin/plan-library/recipes').expect(403);
    });

    it('后台列表：平台看到全部状态并可按状态筛选；协会、机构管理员只看到已发布的', async () => {
      const p = await as(f.users.platform);
      const all = adminRecipeListResponseSchema.parse(
        (await p.get('/api/admin/plan-library/recipes').expect(200)).body,
      );
      expect(all.items).toHaveLength(seed.recipes.length);
      expect(all.items.every((r) => r.status === 'review')).toBe(true);
      const drafts = adminRecipeListResponseSchema.parse(
        (await p.get('/api/admin/plan-library/recipes?status=draft').expect(200)).body,
      );
      expect(drafts.items).toEqual([]);
      for (const u of [f.users.operatorAdminA, f.users.orgAdminA]) {
        const res = await (await as(u)).get('/api/admin/plan-library/exercises').expect(200);
        expect(adminExerciseListResponseSchema.parse(res.body).items, u.email).toEqual([]);
      }
    });

    it('新增：含禁用词、疾病名称、功效承诺 → 400 并标出位置；合格的以草稿保存；code 重复 → 409', async () => {
      const p = await as(f.users.platform);
      const bad = await p
        .post('/api/admin/plan-library/recipes')
        .send(newRecipe({ name: '降血糖青菜汤', steps: ['适合糖尿病的人', '可以根治'] }))
        .expect(400);
      expect(libraryContentRejectionSchema.parse(bad.body).issues).toEqual([
        { path: 'name', term: '降血糖', index: 0 },
        { path: 'steps.0', term: '糖尿病', index: 2 },
        { path: 'steps.1', term: '根治', index: 2 },
      ]);
      // 疾病和功效标签不在固定标签表里
      await p
        .post('/api/admin/plan-library/recipes')
        .send({ ...newRecipe(), tags: ['fit_for_diabetes'] })
        .expect(400);
      // 过敏原必须显式填写
      const { allergens, ...noAllergens } = newRecipe();
      void allergens;
      await p.post('/api/admin/plan-library/recipes').send(noAllergens).expect(400);
      expect(
        await owner
          .selectFrom('plan_library_recipes')
          .select('id')
          .where('code', '=', 'test-veg-soup')
          .execute(),
      ).toEqual([]);

      const ok = adminRecipeResponseSchema.parse(
        (await p.post('/api/admin/plan-library/recipes').send(newRecipe()).expect(201)).body,
      );
      expect(ok.item).toMatchObject({
        code: 'test-veg-soup',
        status: 'draft',
        version: 1,
        updatedByName: expect.any(String),
      });
      const dup = await p.post('/api/admin/plan-library/recipes').send(newRecipe()).expect(409);
      expect(dup.body.reasons).toEqual(['duplicate_code']);
    });

    it('修改：版本号加一；版本号不对 → 409；code 不能改；已发布的要先退回草稿', async () => {
      const p = await as(f.users.platform);
      const id = await seedId('plan_library_recipes', 'test-veg-soup');
      const v2 = adminRecipeResponseSchema.parse(
        (
          await p
            .patch(`/api/admin/plan-library/recipes/${id}`)
            .send({ version: 1, content: newRecipe({ name: '合成青菜豆腐汤' }) })
            .expect(200)
        ).body,
      );
      expect(v2.item).toMatchObject({ name: '合成青菜豆腐汤', version: 2 });
      const stale = await p
        .patch(`/api/admin/plan-library/recipes/${id}`)
        .send({ version: 1, content: newRecipe() })
        .expect(409);
      expect(stale.body.reasons).toEqual(['version_mismatch']);
      await p
        .patch(`/api/admin/plan-library/recipes/${id}`)
        .send({ version: 2, content: newRecipe({ code: 'other-code' }) })
        .expect(400);
      await p
        .patch(`/api/admin/plan-library/recipes/${id}`)
        .send({ version: 2, content: newRecipe({ steps: ['保证见效'] }) })
        .expect(400);
      await p
        .patch('/api/admin/plan-library/recipes/00000000-0000-4000-8000-000000000000')
        .send({ version: 1, content: newRecipe() })
        .expect(404);
    });

    it('状态流转：草稿不能直接发布；发布必须填审定人；发布后健管师可见；停用后 404', async () => {
      const p = await as(f.users.platform);
      const id = await seedId('plan_library_recipes', 'test-veg-soup');
      const jump = await p
        .post(`/api/admin/plan-library/recipes/${id}/status`)
        .send({
          version: 2,
          status: 'published',
          reviewedByLabel: '营养顾问甲',
          reviewedOn: '2026-10-20',
        })
        .expect(409);
      expect(jump.body.reasons).toEqual(['invalid_transition']);
      await p
        .post(`/api/admin/plan-library/recipes/${id}/status`)
        .send({ version: 2, status: 'review' })
        .expect(200);
      // 缺审定人
      await p
        .post(`/api/admin/plan-library/recipes/${id}/status`)
        .send({ version: 2, status: 'published' })
        .expect(400);
      const published = adminRecipeResponseSchema.parse(
        (
          await p
            .post(`/api/admin/plan-library/recipes/${id}/status`)
            .send({
              version: 2,
              status: 'published',
              reviewedByLabel: '营养顾问甲',
              reviewedOn: '2026-10-20',
            })
            .expect(200)
        ).body,
      );
      // 状态变化不改版本号；审定日期原样返回，不因时区挪一天
      expect(published.item).toMatchObject({
        status: 'published',
        version: 2,
        reviewedByLabel: '营养顾问甲',
        reviewedOn: '2026-10-20',
      });

      const m = await as(f.users.managerA1);
      const list = recipeListResponseSchema.parse(
        (await m.get('/api/plan-library/recipes').expect(200)).body,
      );
      expect(list.items.map((r) => r.id)).toEqual([id]);
      recipeDetailResponseSchema.parse(
        (await m.get(`/api/plan-library/recipes/${id}`).expect(200)).body,
      );
      // 运营商在后台只读看到已发布的这一条，看不到修改人
      const op = adminRecipeListResponseSchema.parse(
        (
          await (
            await as(f.users.operatorAdminA)
          )
            .get('/api/admin/plan-library/recipes')
            .expect(200)
        ).body,
      );
      expect(op.items.map((r) => [r.id, r.updatedByName])).toEqual([[id, null]]);

      // 已发布的不能直接改内容
      const notDraft = await p
        .patch(`/api/admin/plan-library/recipes/${id}`)
        .send({ version: 2, content: newRecipe() })
        .expect(409);
      expect(notDraft.body.reasons).toEqual(['not_draft']);

      const retired = adminRecipeResponseSchema.parse(
        (
          await p
            .post(`/api/admin/plan-library/recipes/${id}/status`)
            .send({ version: 2, status: 'retired' })
            .expect(200)
        ).body,
      );
      expect(retired.item).toMatchObject({ status: 'retired', reviewedByLabel: '营养顾问甲' });
      await m.get(`/api/plan-library/recipes/${id}`).expect(404);

      // 退回草稿时审定信息清空
      const back = adminRecipeResponseSchema.parse(
        (
          await p
            .post(`/api/admin/plan-library/recipes/${id}/status`)
            .send({ version: 2, status: 'draft' })
            .expect(200)
        ).body,
      );
      expect(back.item).toMatchObject({ status: 'draft', reviewedByLabel: null, reviewedOn: null });
    });

    it('发布前再检查内容：数据库里不合格的条目（如种子被改坏）不能发布', async () => {
      const p = await as(f.users.platform);
      const id = await seedId('plan_library_recipes', seed.recipes[1]!.code);
      await owner
        .updateTable('plan_library_recipes')
        .set({ name: '护肝小炒' })
        .where('id', '=', id)
        .execute();
      // 内容改了，触发器把版本号加一
      const { version } = await owner
        .selectFrom('plan_library_recipes')
        .select('version')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const res = await p
        .post(`/api/admin/plan-library/recipes/${id}/status`)
        .send({
          version,
          status: 'published',
          reviewedByLabel: '营养顾问甲',
          reviewedOn: '2026-10-20',
        })
        .expect(400);
      expect(res.body.error).toBe('invalid_content');
      expect(res.body.issues).toEqual([{ path: 'name', term: '护肝', index: 0 }]);
      await owner
        .updateTable('plan_library_recipes')
        .set({ name: seed.recipes[1]!.name })
        .where('id', '=', id)
        .execute();
    });

    it('修改记录：新增、修改、状态变化都有，给出改前改后', async () => {
      const p = await as(f.users.platform);
      const id = await seedId('plan_library_recipes', 'test-veg-soup');
      const { events } = libraryItemEventListResponseSchema.parse(
        (await p.get(`/api/admin/plan-library/recipes/${id}/events`).expect(200)).body,
      );
      expect(events.map((e) => e.action)).toEqual([
        'status_changed',
        'status_changed',
        'status_changed',
        'status_changed',
        'updated',
        'created',
      ]);
      const updated = events.find((e) => e.action === 'updated');
      expect(updated?.changes).toEqual([
        { field: 'name', before: '合成青菜汤', after: '合成青菜豆腐汤' },
      ]);
      expect(updated?.actorName).toEqual(expect.any(String));
      await p
        .get('/api/admin/plan-library/recipes/00000000-0000-4000-8000-000000000000/events')
        .expect(404);
    });

    it('目标模板：参数范围和占位符不对 → 400；运动条目注意事项必填', async () => {
      const p = await as(f.users.platform);
      const goal = {
        code: 'test-goal',
        section: 'exercise',
        text: '每天步行 {steps} 步',
        params: [{ name: 'steps', type: 'int', min: 10000, max: 4000, default: 6000, unit: '步' }],
        metric: 'steps',
        metricParam: 'steps',
        sourceNote: '合成',
      };
      await p.post('/api/admin/plan-library/goal-templates').send(goal).expect(400);
      await p
        .post('/api/admin/plan-library/goal-templates')
        .send({
          ...goal,
          text: '每天步行 {walk} 步',
          params: [{ ...goal.params[0], min: 4000, max: 10000 }],
        })
        .expect(400);
      await p
        .post('/api/admin/plan-library/goal-templates')
        .send({ ...goal, params: [{ ...goal.params[0], min: 4000, max: 10000 }] })
        .expect(201);
      const exercise = { ...seed.exercises[0]!, code: 'test-walk', managerCautions: '' };
      await p.post('/api/admin/plan-library/exercises').send(exercise).expect(400);
    });
  });

  describe('随访频次规则', () => {
    it('健管师和三级后台都能读；无登录 → 401', async () => {
      for (const u of [
        f.users.managerA1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const body = visitFrequencyRulesResponseSchema.parse(
          (await (await as(u)).get('/api/visit-frequency-rules').expect(200)).body,
        );
        expect(body.rules).toEqual(DEFAULT_VISIT_FREQUENCY_RULES);
        expect(body.version).toBe(1);
      }
      await request(app.getHttpServer()).get('/api/visit-frequency-rules').expect(401);
    });

    const changed = {
      ...DEFAULT_VISIT_FREQUENCY_RULES,
      tiers: {
        ...DEFAULT_VISIT_FREQUENCY_RULES.tiers,
        high: { intervalDays: 10, defaultMethod: 'in_person' as const },
      },
      firstVisitWithinDays: 2,
    };

    it('非平台管理员改 → 403；超出范围 → 400；都不改任何行', async () => {
      for (const u of [f.users.operatorAdminA, f.users.orgAdminA, f.users.managerA1]) {
        const agent = await as(u);
        await agent.patch('/api/admin/visit-frequency-rules').send(changed).expect(403);
        await agent.get('/api/admin/visit-frequency-rules/events').expect(403);
      }
      const p = await as(f.users.platform);
      for (const bad of [
        { ...changed, firstVisitWithinDays: 0 },
        {
          ...changed,
          tiers: { ...changed.tiers, low: { intervalDays: 365, defaultMethod: 'wechat' } },
        },
        {
          ...changed,
          tiers: { ...changed.tiers, low: { intervalDays: 30, defaultMethod: 'email' } },
        },
      ]) {
        await p.patch('/api/admin/visit-frequency-rules').send(bad).expect(400);
      }
      const body = visitFrequencyRulesResponseSchema.parse(
        (await p.get('/api/visit-frequency-rules').expect(200)).body,
      );
      expect(body).toMatchObject({ version: 1, rules: DEFAULT_VISIT_FREQUENCY_RULES });
    });

    it('平台管理员整套修改：版本号只加一，修改记录逐行给出改前改后；再提交相同内容不加版本号', async () => {
      const p = await as(f.users.platform);
      const res = visitFrequencyRulesResponseSchema.parse(
        (await p.patch('/api/admin/visit-frequency-rules').send(changed).expect(200)).body,
      );
      expect(res).toMatchObject({ version: 2, rules: changed });
      const { events } = visitFrequencyRuleEventListResponseSchema.parse(
        (await p.get('/api/admin/visit-frequency-rules/events').expect(200)).body,
      );
      expect(
        events.map((e) => ({
          target: e.target,
          before: e.before,
          after: e.after,
          v: e.rulesVersion,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            target: 'high',
            before: { intervalDays: 14, defaultMethod: 'phone' },
            after: { intervalDays: 10, defaultMethod: 'in_person' },
            v: 2,
          },
          {
            target: 'first_visit',
            before: { firstVisitWithinDays: 3 },
            after: { firstVisitWithinDays: 2 },
            v: 2,
          },
        ]),
      );
      expect(events).toHaveLength(2);
      const again = visitFrequencyRulesResponseSchema.parse(
        (await p.patch('/api/admin/visit-frequency-rules').send(changed).expect(200)).body,
      );
      expect(again.version).toBe(2);
      // 健管师读到新规则
      const m = visitFrequencyRulesResponseSchema.parse(
        (await (await as(f.users.managerA1)).get('/api/visit-frequency-rules').expect(200)).body,
      );
      expect(m.rules).toEqual(changed);
    });
  });
});
