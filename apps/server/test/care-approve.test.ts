import type { INestApplication } from '@nestjs/common';
import {
  DISCLAIMER,
  planStatsResponseSchema,
  twinTimelineResponseSchema,
  type CarePlanStructured,
} from '@health-buddy/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { insertTask } from './work-fixtures.js';

const DAY = 86_400_000;
const dayOffset = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const CLIENT_TEXT = `每天晚饭后散步十五分钟，早餐吃燕麦粥。\n\n${DISCLAIMER}`;

/**
 * M5 第 3 步（3b）：方案、随访计划、随访记录、随访话术按类型确认（规格 2.3、2.7、2.9、5.4 第 1 条），
 * 结构化内容的修改，孪生时间轴的新事件，统计，以及跨租户拒绝。全部是合成数据。
 */
describe('方案和随访产物的确认', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  const as = (u: Account) => loginAs(app, u.email);
  const lib = { recipe: '', peanutRecipe: '', exercise: '', goal: '' };

  const scopeA1 = () => ({
    operatorId: f.operatorA,
    orgId: f.orgA,
    managerId: f.users.managerA1.id,
  });

  async function draft(
    clientId: string,
    kind: 'care_plan' | 'visit_schedule' | 'visit_record' | 'visit_script',
    structured: unknown,
    clientFacing = '',
  ): Promise<string> {
    const taskId = await insertTask(owner, scopeA1(), clientId);
    const id = randomUUID();
    await owner
      .insertInto('artifacts')
      .values({
        id,
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
        task_id: taskId,
        client_id: clientId,
        skill_id: kind.replace('_', '-'),
        kind,
        lineage_id: id,
        version: 1,
        status: 'draft',
        content: JSON.stringify({ professional: '合成专业版', clientFacing }),
        critical_flags: JSON.stringify([]),
        structured: structured === null ? null : JSON.stringify(structured),
        ...(kind === 'care_plan'
          ? { plan_options: JSON.stringify({ sections: ['diet', 'exercise'], cycleWeeks: 8 }) }
          : {}),
      } as never)
      .execute();
    return id;
  }

  const plan = (over: Partial<CarePlanStructured> = {}): CarePlanStructured => ({
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

  async function approve(u: Account, id: string, extra: Record<string, unknown> = {}) {
    const agent = await as(u);
    const detail = await agent.get(`/api/artifacts/${id}`);
    const body = detail.body.artifact
      ? { version: detail.body.artifact.version, contentHash: detail.body.artifact.contentHash }
      : { version: 1, contentHash: 'x' };
    return agent.post(`/api/artifacts/${id}/approve`).send({ ...body, ...extra });
  }

  const published = {
    status: 'published',
    reviewed_by_label: '合成审定人',
    reviewed_on: '2026-10-01',
    source_note: '合成',
  };

  beforeAll(async () => {
    f = await seedFixtures(owner);
    const recipe = (code: string, allergens: string[]) =>
      owner
        .insertInto('plan_library_recipes')
        .values({
          code,
          name: `合成食谱 ${code}`,
          meal_types: ['breakfast'],
          ingredients: JSON.stringify([{ name: '燕麦', householdAmount: '半碗' }]),
          steps: JSON.stringify(['煮开']),
          allergens,
          ...published,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    lib.recipe = (await recipe('test-oat', [])).id as string;
    lib.peanutRecipe = (await recipe('test-peanut', ['peanut'])).id as string;
    lib.exercise = (
      await owner
        .insertInto('plan_library_exercises')
        .values({
          code: 'test-walk',
          name: '合成快走',
          category: 'aerobic',
          intensity: 'low',
          setting: ['outdoor'],
          steps: JSON.stringify(['走']),
          key_points: JSON.stringify(['抬头']),
          manager_cautions: '合成注意事项',
          ...published,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
    lib.goal = (
      await owner
        .insertInto('plan_goal_templates')
        .values({
          code: 'test-steps',
          section: 'exercise',
          text: '每天步行 {steps} 步',
          params: JSON.stringify([
            { name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' },
          ]),
          metric: 'steps',
          metric_param: 'steps',
          ...published,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  describe('方案', () => {
    it('确认后生效：写入 care_plans，排一次方案复评；再确认一份时旧方案被替代', async () => {
      const first = await draft(f.clients.a1[0], 'care_plan', plan(), CLIENT_TEXT);
      const res = await approve(f.users.managerA1, first);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.artifact.status).toBe('approved');
      const plans = await owner
        .selectFrom('care_plans')
        .select(['id', 'status', 'artifact_id'])
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      expect(plans).toEqual([expect.objectContaining({ status: 'active', artifact_id: first })]);
      const review = await owner
        .selectFrom('visits')
        .select(['purpose', 'status', 'origin'])
        .where('care_plan_id', '=', plans[0]!.id)
        .execute();
      expect(review).toEqual([
        { purpose: 'plan_review', status: 'planned', origin: 'plan_review' },
      ]);

      const second = await draft(f.clients.a1[0], 'care_plan', plan(), CLIENT_TEXT);
      expect((await approve(f.users.managerA1, second)).status).toBe(200);
      const after = await owner
        .selectFrom('care_plans')
        .select(['artifact_id', 'status'])
        .where('client_id', '=', f.clients.a1[0])
        .orderBy('approved_at')
        .execute();
      expect(after.map((p) => p.status)).toEqual(['superseded', 'active']);

      // 孪生时间轴：方案生效、被替代
      const tl = twinTimelineResponseSchema.parse(
        (
          await (
            await as(f.users.managerA1)
          )
            .get(`/api/clients/${f.clients.a1[0]}/twin/timeline?types=care_plan`)
            .expect(200)
        ).body,
      );
      expect(tl.events.map((e) => e.type === 'care_plan' && e.action).sort()).toEqual([
        'activated',
        'activated',
        'superseded',
      ]);

      // 已审核的方案可以复制通俗版；导出文件名是“健康方案 日期 第几版”
      const agent = await as(f.users.managerA1);
      const copied = await agent.post(`/api/artifacts/${second}/copy`).expect(200);
      expect(copied.body.text).toContain(DISCLAIMER);
      const exported = await agent
        .post(`/api/artifacts/${second}/export`)
        .send({ format: 'pdf' })
        .expect(200);
      expect(decodeURIComponent(String(exported.headers['content-disposition']))).toContain(
        '健康方案',
      );
    });

    it('通俗版有药名、孪生字样、专家名称时不能确认；不写 care_plans', async () => {
      const before = await owner.selectFrom('care_plans').select('id').execute();
      for (const [text, reason] of [
        ['每天按时吃二甲双胍。', 'drug_in_client_text'],
        ['您的孪生状态为黄。', 'twin_in_client_text'],
        ['营养专家建议多吃蔬菜。', 'expert_in_client_text'],
      ] as const) {
        const id = await draft(f.clients.a1[1], 'care_plan', plan(), `${text}\n\n${DISCLAIMER}`);
        const res = await approve(f.users.managerA1, id);
        expect(res.status).toBe(409);
        expect(res.body.reasons).toContain(reason);
      }
      expect(await owner.selectFrom('care_plans').select('id').execute()).toEqual(before);
    });

    it('做法和固定说法不误判；孪生颜色的其他写法、每一部分的通俗版也查', async () => {
      const okText = `加姜片和热水小火炖 1 小时，早餐可以吃一颗鸡蛋，加入山药块。如在服用药物，用药调整由医生评估。\n\n${DISCLAIMER}`;
      const ok = await draft(f.clients.a1[1], 'care_plan', plan(), okText);
      const okRes = await approve(f.users.managerA1, ok);
      expect(okRes.status, JSON.stringify(okRes.body)).toBe(200);
      const variant = await draft(
        f.clients.a1[1],
        'care_plan',
        plan(),
        `您的状态是黄，记得多散步。\n\n${DISCLAIMER}`,
      );
      expect((await approve(f.users.managerA1, variant)).body.reasons).toContain(
        'twin_in_client_text',
      );
      const sectionText = plan();
      sectionText.sections[0]!.clientFacing = '可以吃点钙片';
      const section = await draft(f.clients.a1[1], 'care_plan', sectionText, CLIENT_TEXT);
      expect((await approve(f.users.managerA1, section)).body.reasons).toContain(
        'drug_in_client_text',
      );
    });

    it('引用的库条目必须已发布；目标参数必须在模板范围内', async () => {
      const out = await draft(
        f.clients.a1[1],
        'care_plan',
        plan({
          sections: [
            {
              section: 'exercise',
              professional: '合成',
              clientFacing: '合成',
              goals: [{ templateId: lib.goal, params: { steps: 20000 } }],
            },
          ],
          recipes: [],
        }),
        CLIENT_TEXT,
      );
      expect((await approve(f.users.managerA1, out)).body.reasons).toEqual([
        'goal_param_out_of_range',
      ]);
      const retired = (
        await owner
          .insertInto('plan_library_recipes')
          .values({
            code: 'test-retired',
            name: '合成停用食谱',
            meal_types: ['lunch'],
            ingredients: JSON.stringify([{ name: '青菜', householdAmount: '一把' }]),
            steps: JSON.stringify(['炒']),
            allergens: [],
            ...published,
            status: 'retired',
          } as never)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id as string;
      const gone = await draft(
        f.clients.a1[1],
        'care_plan',
        plan({ recipes: [{ day: 1, meal: 'lunch', recipeId: retired }] }),
        CLIENT_TEXT,
      );
      expect((await approve(f.users.managerA1, gone)).body.reasons).toEqual([
        'library_item_unavailable',
      ]);
    });

    it('用到的食谱和过敏史冲突时必须勾选“已核对过敏原”', async () => {
      await owner
        .insertInto('client_health_history')
        .values({
          client_id: f.clients.a1[1],
          category: 'allergy',
          content: '花生过敏',
          created_by: f.users.managerA1.id,
        } as never)
        .execute();
      const id = await draft(
        f.clients.a1[1],
        'care_plan',
        plan({ recipes: [{ day: 2, meal: 'breakfast', recipeId: lib.peanutRecipe }] }),
        CLIENT_TEXT,
      );
      const res = await approve(f.users.managerA1, id);
      expect(res.body.reasons).toEqual(['allergens_not_acknowledged']);
      expect((await approve(f.users.managerA1, id, { acknowledgedAllergens: true })).status).toBe(
        200,
      );
    });

    it('修改结构化内容：替换成已发布的条目可以；未发布的条目、超范围的参数 → 400', async () => {
      const id = await draft(f.clients.a1[1], 'care_plan', plan(), CLIENT_TEXT);
      const agent = await as(f.users.managerA1);
      const detail = (await agent.get(`/api/artifacts/${id}`).expect(200)).body.artifact;
      const base = {
        version: detail.version,
        contentHash: detail.contentHash,
        content: detail.content,
      };
      await agent
        .patch(`/api/artifacts/${id}`)
        .send({
          ...base,
          structured: plan({ recipes: [{ day: 1, meal: 'breakfast', recipeId: randomUUID() }] }),
        })
        .expect(400);
      await agent
        .patch(`/api/artifacts/${id}`)
        .send({
          ...base,
          structured: plan({
            sections: [
              {
                section: 'exercise',
                professional: '合成',
                clientFacing: '合成',
                goals: [{ templateId: lib.goal, params: { steps: 1 } }],
              },
            ],
            recipes: [],
          }),
        })
        .expect(400);
      const ok = await agent
        .patch(`/api/artifacts/${id}`)
        .send({
          ...base,
          structured: plan({ recipes: [{ day: 3, meal: 'breakfast', recipeId: lib.recipe }] }),
        })
        .expect(200);
      expect(ok.body.artifact.structured.recipes).toEqual([
        { day: 3, meal: 'breakfast', recipeId: lib.recipe },
      ]);
      // 结构化内容改了，内容指纹也变（别人改过就能发现）
      expect(ok.body.artifact.contentHash).not.toBe(detail.contentHash);
    });

    it('跨租户：别的健管师确认、修改都是 404，不写任何行', async () => {
      const id = await draft(f.clients.a1[1], 'care_plan', plan(), CLIENT_TEXT);
      const others = {
        visit_schedule: await draft(f.clients.a1[1], 'visit_schedule', {
          rows: [{ dueDate: dayOffset(5), method: 'phone', purpose: 'routine', focus: null }],
        }),
        visit_record: await draft(f.clients.a1[1], 'visit_record', {
          visitDate: dayOffset(0),
          method: 'phone',
          summary: '合成',
          feedback: [],
          planProgress: [],
          agreements: [],
          attentionPoints: [],
          historySuggestions: [],
          openQuestions: [],
        }),
      };
      const before = await owner.selectFrom('care_plans').select('id').execute();
      const visitsBefore = await owner.selectFrom('visits').select('id').execute();
      const recordsBefore = await owner.selectFrom('visit_records').select('id').execute();
      const artifactBefore = await owner
        .selectFrom('artifacts')
        .select(['structured', 'content'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      for (const u of [f.users.managerA2, f.users.managerA3, f.users.managerB1]) {
        const agent = await as(u);
        for (const target of [id, others.visit_schedule, others.visit_record]) {
          await agent
            .post(`/api/artifacts/${target}/approve`)
            .send({ version: 1, contentHash: 'x' })
            .expect(404);
        }
        await agent
          .patch(`/api/artifacts/${id}`)
          .send({
            version: 1,
            contentHash: 'x',
            content: { professional: '越权', clientFacing: CLIENT_TEXT },
            structured: plan({ recipes: [] }),
          })
          .expect(404);
      }
      expect(await owner.selectFrom('visits').select('id').execute()).toEqual(visitsBefore);
      expect(await owner.selectFrom('visit_records').select('id').execute()).toEqual(recordsBefore);
      expect(
        await owner
          .selectFrom('artifacts')
          .select(['structured', 'content'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual(artifactBefore);
      for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
        const agent = await as(u);
        await agent
          .post(`/api/artifacts/${id}/approve`)
          .send({ version: 1, contentHash: 'x' })
          .expect(404);
      }
      expect(await owner.selectFrom('care_plans').select('id').execute()).toEqual(before);
      const row = await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('draft');
    });

    it('执行情况：目标模板以后被停用也照样能算', async () => {
      await owner
        .updateTable('plan_goal_templates')
        .set({ status: 'retired' } as never)
        .where('id', '=', lib.goal)
        .execute();
      try {
        const res = await (
          await as(f.users.managerA1)
        )
          .get(`/api/clients/${f.clients.a1[0]}/care-plans/current/adherence`)
          .expect(200);
        expect(res.body.adherence.goals.map((g: { templateId: string }) => g.templateId)).toEqual([
          lib.goal,
        ]);
        expect(res.body.adherence.untrackedTemplateIds).toEqual([]);
      } finally {
        await owner
          .updateTable('plan_goal_templates')
          .set({ status: 'published' } as never)
          .where('id', '=', lib.goal)
          .execute();
      }
    });
  });

  describe('随访计划', () => {
    const schedule = (rows: { dueDate: string }[]) => ({
      rows: rows.map((r) => ({ ...r, method: 'phone', purpose: 'routine', focus: '合成重点' })),
    });

    it('改日程：日期超出范围 → 400；确认后写入待随访；没有复制和导出', async () => {
      const own = await draft(
        f.clients.a1[1],
        'visit_schedule',
        schedule([{ dueDate: dayOffset(7) }, { dueDate: dayOffset(30) }]),
      );
      const agent = await as(f.users.managerA1);
      const detail = (await agent.get(`/api/artifacts/${own}`).expect(200)).body.artifact;
      const base = { version: 1, contentHash: detail.contentHash, content: detail.content };
      await agent
        .patch(`/api/artifacts/${own}`)
        .send({ ...base, structured: schedule([{ dueDate: dayOffset(-2) }]) })
        .expect(400);
      await agent
        .patch(`/api/artifacts/${own}`)
        .send({ ...base, structured: schedule([{ dueDate: dayOffset(400) }]) })
        .expect(400);
      const res = await approve(f.users.managerA1, own);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const visits = await owner
        .selectFrom('visits')
        .select(['status', 'origin'])
        .where('source_artifact_id', '=', own)
        .execute();
      expect(visits).toEqual([
        { status: 'planned', origin: 'schedule' },
        { status: 'planned', origin: 'schedule' },
      ]);
      await agent.post(`/api/artifacts/${own}/copy`).expect(409);
      await agent.post(`/api/artifacts/${own}/export`).send({ format: 'pdf' }).expect(409);
    });
  });

  describe('随访记录和话术', () => {
    const record = (over: Record<string, unknown> = {}) => ({
      visitDate: dayOffset(0),
      method: 'phone',
      summary: '合成摘要：客户说最近晚饭后散步。',
      feedback: [],
      planProgress: [],
      agreements: [],
      attentionPoints: [],
      historySuggestions: [],
      openQuestions: [],
      ...over,
    });

    it('没有随访日期或方式不能确认', async () => {
      const id = await draft(f.clients.a1[1], 'visit_record', record({ visitDate: null }));
      expect((await approve(f.users.managerA1, id)).body.reasons).toEqual(['record_incomplete']);
    });

    it('健管师补填随访日期和方式后可以确认；日期在今天之后 → 400', async () => {
      const id = await draft(
        f.clients.a1[1],
        'visit_record',
        record({ visitDate: null, method: null }),
      );
      const agent = await as(f.users.managerA1);
      const detail = (await agent.get(`/api/artifacts/${id}`).expect(200)).body.artifact;
      const base = { version: 1, contentHash: detail.contentHash, content: detail.content };
      await agent
        .patch(`/api/artifacts/${id}`)
        // 两天后：按 UTC 算的明天在北京时间晚上已经是“今天”，用两天后才和时区无关
        .send({ ...base, structured: record({ visitDate: dayOffset(2) }) })
        .expect(400);
      const saved = await agent
        .patch(`/api/artifacts/${id}`)
        .send({ ...base, structured: record({ visitDate: dayOffset(-1), method: 'wechat' }) })
        .expect(200);
      expect(saved.body.artifact.structured).toMatchObject({
        visitDate: dayOffset(-1),
        method: 'wechat',
      });
      const res = await approve(f.users.managerA1, id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('别人的随访记录草稿：改结构化内容 → 404，不改任何行', async () => {
      const id = await draft(f.clients.a1[1], 'visit_record', record({ visitDate: null }));
      const agent = await as(f.users.managerB1);
      await agent
        .patch(`/api/artifacts/${id}`)
        .send({
          version: 1,
          contentHash: 'x',
          content: { professional: '合成', clientFacing: '' },
          structured: record(),
        })
        .expect(404);
      const row = await owner
        .selectFrom('artifacts')
        .select('structured')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect((row.structured as { visitDate: string | null }).visitDate).toBeNull();
    });

    it('勾选了别的客户的跟进项 → 404，整个确认回滚', async () => {
      const otherItem = await owner
        .insertInto('follow_up_items')
        .values({
          client_id: f.clients.a1[0],
          kind: 'status_worsened',
          severity: 3,
          domain: 'metabolic',
          dedupe_key: 'approve-test-a',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      const id = await draft(f.clients.a1[1], 'visit_record', record());
      const res = await approve(f.users.managerA1, id, {
        resolveFollowUpItemIds: [otherItem.id],
      });
      expect(res.status).toBe(404);
      const row = await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('draft');
      expect(
        await owner
          .selectFrom('visit_records')
          .select('id')
          .where('artifact_id', '=', id)
          .execute(),
      ).toEqual([]);
    });

    it('确认后写入随访记录，勾选的跟进项标为已处理，进入时间轴', async () => {
      const item = await owner
        .insertInto('follow_up_items')
        .values({
          client_id: f.clients.a1[1],
          kind: 'status_worsened',
          severity: 3,
          domain: 'metabolic',
          dedupe_key: 'approve-test-b',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      const id = await draft(f.clients.a1[1], 'visit_record', record());
      const res = await approve(f.users.managerA1, id, { resolveFollowUpItemIds: [item.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const done = await owner
        .selectFrom('follow_up_items')
        .select(['status', 'resolution'])
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow();
      expect(done).toEqual({ status: 'done', resolution: 'called' });
      const tl = twinTimelineResponseSchema.parse(
        (
          await (
            await as(f.users.managerA1)
          )
            .get(`/api/clients/${f.clients.a1[1]}/twin/timeline?types=visit_record`)
            .expect(200)
        ).body,
      );
      expect(tl.events[0]).toMatchObject({ type: 'visit_record', visitDate: dayOffset(0) });
      // 机构管理员看不到随访类事件
      const orgView = await (
        await as(f.users.orgAdminA)
      )
        .get(`/api/clients/${f.clients.a1[1]}/twin/timeline?types=visit_record`)
        .expect(200);
      expect(orgView.body.events).toEqual([]);
    });

    it('随访话术只有专业版：不查免责声明，可以确认，不能复制', async () => {
      const id = await draft(f.clients.a1[1], 'visit_script', null);
      const res = await approve(f.users.managerA1, id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await (await as(f.users.managerA1)).post(`/api/artifacts/${id}/copy`).expect(409);
    });
  });

  describe('统计', () => {
    it('运营商只看本协会，平台看全部；健管师、机构管理员 403；不含客户和健管师 id', async () => {
      const op = planStatsResponseSchema.parse(
        (await (await as(f.users.operatorAdminA)).get('/api/plan-stats').expect(200)).body,
      );
      expect(op.scope).toBe('operator');
      expect(op.totals.plansApproved).toBeGreaterThanOrEqual(3);
      expect(op.totals.recordsApproved).toBeGreaterThanOrEqual(1);
      expect(op.rows.every((r) => r.operatorId === null)).toBe(true);
      const b = planStatsResponseSchema.parse(
        (
          await (
            await as(f.users.operatorAdminB)
          )
            .get(`/api/plan-stats?operatorId=${f.operatorA}`)
            .expect(200)
        ).body,
      );
      expect(b.totals.plansApproved).toBe(0);
      const p = planStatsResponseSchema.parse(
        (await (await as(f.users.platform)).get('/api/plan-stats').expect(200)).body,
      );
      expect(p.rows.some((r) => r.operatorId === f.operatorA)).toBe(true);
      const text = JSON.stringify(p);
      expect(text).not.toContain(f.clients.a1[0]);
      expect(text).not.toContain(f.users.managerA1.id);
      for (const u of [f.users.managerA1, f.users.orgAdminA]) {
        await (await as(u)).get('/api/plan-stats').expect(403);
      }
    });
  });

  describe('客户转出（Q30）', () => {
    it('方案和记录跟着客户走：原健管师 404，新健管师看得到', async () => {
      const m1 = await as(f.users.managerA1);
      const plans = (await m1.get(`/api/clients/${f.clients.a1[1]}/care-plans`).expect(200)).body;
      const planId = plans.current.id as string;
      const records = (await m1.get(`/api/clients/${f.clients.a1[1]}/visit-records`).expect(200))
        .body.records;
      const recordId = records[0].id as string;
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id } as never)
        .where('id', '=', f.clients.a1[1])
        .execute();
      await m1.get(`/api/clients/${f.clients.a1[1]}/care-plans`).expect(404);
      await m1.get(`/api/care-plans/${planId}`).expect(404);
      await m1.get(`/api/visit-records/${recordId}`).expect(404);
      const m2 = await as(f.users.managerA2);
      const moved = (await m2.get(`/api/care-plans/${planId}`).expect(200)).body.plan;
      // 对原健管师产物的引用置空，快照保留
      expect(moved.artifactId).toBeNull();
      expect(moved.snapshot.content.clientFacing).toBe(CLIENT_TEXT);
      await m2.get(`/api/visit-records/${recordId}`).expect(200);
    });
  });
});
