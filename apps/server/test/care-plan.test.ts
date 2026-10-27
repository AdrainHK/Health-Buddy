import {
  DEFAULT_VISIT_FREQUENCY_RULES,
  addDaysIso,
  dateInTimeZone,
  scheduleVisits,
} from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M5 第 5 步：/方案生成（规格 2.2–2.5、5.2–5.4、Q8、Q16）。候选库条目由后端筛好（过敏原排除、
 * 运动安全规则），模型只能选候选 id；结构不合格重试一次，仍不合格不保存草稿。
 * 资料太少时 409 no_plan_data；跨租户一律 404，不调用模型。全部是合成数据。
 */
describe('/方案生成', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  let app: INestApplication;
  let f: Fixtures;
  const lib = { oat: '', peanut: '', review: '', walk: '', breath: '', veg: '', steps: '' };

  const as = (email: string) => loginAs(app, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const artifactsOf = (taskId: string) =>
    owner.selectFrom('artifacts').selectAll().where('task_id', '=', taskId).execute();
  const stepKinds = (text: string) =>
    parseSse(text).flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
  const prompt = () => JSON.stringify(provider.calls.at(-1)!.messages);

  const published = {
    status: 'published',
    reviewed_by_label: '合成审定人',
    reviewed_on: '2026-10-01',
    source_note: '合成',
  };

  /** 饮食和运动两部分的合格输出 */
  const reply = (over: Record<string, unknown> = {}) => ({
    json: {
      sections: [
        {
          section: 'diet',
          professional: '早餐选高纤维的做法。',
          clientFacing: '早餐换成燕麦粥，晚餐多一份蔬菜。',
          goals: [{ templateId: lib.veg, params: [{ name: 'portions', value: '4' }] }],
        },
        {
          section: 'exercise',
          professional: '从低强度开始。',
          clientFacing: '晚饭后散步，微微出汗就好。',
          goals: [{ templateId: lib.steps, params: [{ name: 'steps', value: '6000' }] }],
        },
      ],
      recipes: [{ day: 1, meal: 'breakfast', recipeId: lib.oat }],
      exercises: [{ exerciseId: lib.walk, frequencyPerWeek: 3, minutes: 20 }],
      overview: {
        basis: ['资料里没有饮食记录'],
        focus: ['规律三餐'],
        medicalReview: null,
        changes: [],
      },
      followUpFocus: ['了解早餐调整的执行情况'],
      referral: [],
      dataGaps: [],
      notes: [],
      crisisSignal: false,
      ...over,
    },
  });
  const OPTIONS = { sections: ['diet', 'exercise'], cycleWeeks: 4 };

  /** 方案库是全局表，按 code 插入（seedFixtures 的 truncate cascade 会一并清掉，每个用例重插） */
  async function seedLibrary() {
    const upsert = async (table: string, code: string, values: Record<string, unknown>) => {
      await owner
        .insertInto(table as never)
        .values({ code, ...published, ...values } as never)
        .onConflict((oc) => oc.column('code' as never).doNothing())
        .execute();
      const row = await owner
        .selectFrom(table as never)
        .select('id' as never)
        .where('code' as never, '=', code as never)
        .executeTakeFirstOrThrow();
      return (row as { id: string }).id;
    };
    const recipe = (code: string, allergens: string[], extra: Record<string, unknown> = {}) =>
      upsert('plan_library_recipes', code, {
        name: `合成食谱 ${code}`,
        meal_types: ['breakfast'],
        ingredients: JSON.stringify([{ name: '燕麦', householdAmount: '半碗' }]),
        steps: JSON.stringify(['煮开']),
        allergens,
        ...extra,
      });
    lib.oat = await recipe('cp-test-oat', []);
    lib.peanut = await recipe('cp-test-peanut', ['peanut']);
    // 待审定的条目：预览开关关闭时不进候选
    lib.review = await recipe('cp-test-review', [], {
      status: 'review',
      reviewed_by_label: null,
      reviewed_on: null,
    });
    const exercise = (code: string, category: string) =>
      upsert('plan_library_exercises', code, {
        name: `合成动作 ${code}`,
        category,
        intensity: 'low',
        setting: ['home'],
        steps: JSON.stringify(['慢慢做']),
        key_points: JSON.stringify(['放松']),
        manager_cautions: '合成注意事项',
      });
    lib.walk = await exercise('cp-test-walk', 'aerobic');
    lib.breath = await exercise('cp-test-breath', 'relaxation');
    const template = (code: string, section: string, param: Record<string, unknown>) =>
      upsert('plan_goal_templates', code, {
        section,
        text: `合成目标 {${String(param.name)}}`,
        params: JSON.stringify([param]),
        metric: null,
        metric_param: null,
      });
    lib.veg = await template('cp-test-veg', 'diet', {
      name: 'portions',
      type: 'int',
      min: 3,
      max: 6,
      default: 4,
      unit: '份',
    });
    lib.steps = await template('cp-test-steps', 'exercise', {
      name: 'steps',
      type: 'int',
      min: 4000,
      max: 10000,
      default: 6000,
      unit: '步',
    });
  }

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    await seedLibrary();
    provider.reset();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('生成草稿：读方案库候选；过敏原排除；结构化内容和方案选项存在草稿上；提示词没有姓名', async () => {
    await owner
      .insertInto('client_health_history')
      .values({
        client_id: f.clients.a1[0],
        category: 'allergy',
        content: '花生过敏',
        created_by: f.users.managerA1.id,
      } as never)
      .execute();
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply();
    const res = await send(a1, task, {
      mode: 'craft',
      content: '测试客户 A1-1 早上没时间做饭',
      skillId: 'care-plan',
      planOptions: OPTIONS,
    }).expect(200);
    expect(stepKinds(res.text)).toEqual([
      'read_client',
      'read_twin',
      'read_care_plan',
      'select_library_items',
      'detect_critical',
      'run_skill',
    ]);
    const text = prompt();
    expect(text).toContain(lib.oat);
    expect(text).not.toContain(lib.peanut);
    expect(text).not.toContain(lib.review);
    expect(text).toContain('因过敏史排除了 1 份食谱');
    expect(text).toContain('周期：4 周');
    expect(text).not.toContain('测试客户');

    const [artifact] = await artifactsOf(task);
    expect(artifact).toMatchObject({ kind: 'care_plan', status: 'draft', plan_options: OPTIONS });
    const structured = artifact!.structured as {
      sections: { section: string; goals: { params: Record<string, unknown> }[] }[];
      recipes: { recipeId: string }[];
    };
    expect(structured.sections.map((s) => s.section)).toEqual(['diet', 'exercise']);
    expect(structured.sections[0]!.goals[0]!.params).toEqual({ portions: 4 });
    expect(structured.recipes).toEqual([{ day: 1, meal: 'breakfast', recipeId: lib.oat }]);
    const content = artifact!.content as { clientFacing: string; professional: string };
    expect(content.clientFacing).toContain('煮开');
    expect(content.clientFacing).not.toContain('合成注意事项');
    expect(content.professional).toContain('合成注意事项');
  });

  it('没传方案选项时按默认（全选、8 周）记下', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply();
    await send(a1, task, { mode: 'craft', content: '', skillId: 'care-plan' }).expect(200);
    const message = await owner
      .selectFrom('task_messages')
      .select('plan_options')
      .where('task_id', '=', task)
      .where('role', '=', 'manager')
      .executeTakeFirstOrThrow();
    expect(message.plan_options).toEqual({
      sections: ['diet', 'exercise', 'routine', 'mind'],
      cycleWeeks: 8,
    });
    expect(prompt()).toContain('包含：饮食、运动、作息、心理');
  });

  it('选了库外条目：带纠正说明重试一次；仍不合格就不保存草稿', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const wrong = reply({ recipes: [{ day: 1, meal: 'breakfast', recipeId: lib.peanut }] });
    provider.scripts.skill = [
      reply({ recipes: [{ day: 1, meal: 'breakfast', recipeId: 'x' }] }),
      reply(),
    ];
    await send(a1, task, {
      mode: 'craft',
      content: '',
      skillId: 'care-plan',
      planOptions: OPTIONS,
    }).expect(200);
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain('只能用候选的 id');
    expect(await artifactsOf(task)).toHaveLength(1);

    // 过敏客户：带过敏原的食谱不在候选里，同样不合格
    await owner
      .insertInto('client_health_history')
      .values({
        client_id: f.clients.a1[0],
        category: 'allergy',
        content: '花生过敏',
        created_by: f.users.managerA1.id,
      } as never)
      .execute();
    const again = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.reset();
    provider.scripts.skill = wrong;
    const res = await send(a1, again, {
      mode: 'craft',
      content: '',
      skillId: 'care-plan',
      planOptions: OPTIONS,
    }).expect(200);
    expect(provider.calls).toHaveLength(2);
    expect(res.text).toContain('wording_check_failed');
    expect(await artifactsOf(again)).toHaveLength(0);
  });

  it('要求里有疑似急症信号：运动部分按安全规则处理，候选里没有运动动作和运动目标', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply({
      sections: [
        {
          section: 'diet',
          professional: '早餐选高纤维的做法。',
          clientFacing: '早餐换成燕麦粥。',
          goals: [],
        },
        {
          section: 'exercise',
          professional: '有疑似急症信号，先就医。',
          clientFacing: '建议先就医评估再开始运动。',
          goals: [],
        },
      ],
      exercises: [],
      overview: {
        basis: ['资料里没有'],
        focus: ['规律三餐'],
        medicalReview: '客户描述胸痛、出冷汗，运动前先就医评估。',
        changes: [],
      },
    });
    await send(a1, task, {
      mode: 'craft',
      content: '客户说爬楼时胸痛，还出冷汗',
      skillId: 'care-plan',
      planOptions: OPTIONS,
    }).expect(200);
    const text = prompt();
    expect(text).toContain('运动安全规则：有疑似急症信号');
    expect(text).not.toContain(lib.walk);
    expect(text).not.toContain(lib.steps);
    expect(await artifactsOf(task)).toHaveLength(1);
  });

  it('想一想“方案和随访”：先出计划，确认后起草方案和随访计划；方案复评按草稿周期排，方案生效后才写入日程', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, {
      mode: 'plan',
      content: '',
      skillId: 'plan-and-visits',
      planOptions: OPTIONS,
    }).expect(200);
    const plan = parseSse(res.text).find((e) => e.type === 'plan');
    expect(plan?.type === 'plan' && plan.plan.steps).toEqual([
      { kind: 'read_client' },
      { kind: 'read_twin' },
      { kind: 'run_skill', skillId: 'care-plan' },
      { kind: 'run_skill', skillId: 'visit-schedule' },
    ]);
    expect(provider.calls).toHaveLength(0);

    // 方案草稿周期 4 周：方案复评在今天 + 28 天（和后端同一个纯函数）
    const now = new Date();
    const rows = scheduleVisits({
      now,
      timeZone: 'Asia/Shanghai',
      riskTier: null,
      rules: DEFAULT_VISIT_FREQUENCY_RULES,
      planReviewDate: addDaysIso(dateInTimeZone(now, 'Asia/Shanghai'), 28),
      hasUrgentFollowUp: false,
    }).visits;
    expect(rows.some((r) => r.purpose === 'plan_review')).toBe(true);
    provider.scripts.skill = [
      reply(),
      {
        json: {
          rows: rows.map((r) => ({ ...r, focus: '了解早餐调整的执行情况' })),
          notes: [],
          crisisSignal: false,
        },
      },
    ];
    const planId = plan?.type === 'plan' ? plan.plan.id : '';
    await a1.post(`/api/tasks/${task}/plans/${planId}/confirm`).expect(200);
    const drafts = await artifactsOf(task);
    expect(drafts.map((a) => a.kind).sort()).toEqual(['care_plan', 'visit_schedule']);
    expect(drafts.find((a) => a.kind === 'care_plan')?.plan_options).toEqual(OPTIONS);
    const schedulePrompt = JSON.stringify(provider.calls.at(-1)!.messages);
    expect(schedulePrompt).toContain('方案复评按本次刚生成的方案草稿排：周期 4 周');

    const approve = async (kind: string) => {
      const id = drafts.find((a) => a.kind === kind)!.id;
      const detail = (await a1.get(`/api/artifacts/${id}`).expect(200)).body.artifact;
      const r = await a1
        .post(`/api/artifacts/${id}/approve`)
        .send({ version: detail.version, contentHash: detail.contentHash });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const review = () =>
      owner
        .selectFrom('visits')
        .select(['status', 'care_plan_id'])
        .where('client_id', '=', f.clients.a1[0])
        .where('purpose', '=', 'plan_review')
        .execute();
    // 随访计划先确认：方案复评这一行待方案生效
    await approve('visit_schedule');
    expect(await review()).toEqual([{ status: 'pending_plan', care_plan_id: null }]);
    // 方案生效后，这一行转为待随访并挂到新方案上
    await approve('care_plan');
    const after = await review();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'planned' });
    expect(after[0]!.care_plan_id).not.toBeNull();
  });

  it('客户资料太少（没有报告、近期监测和生活习惯）：409 no_plan_data，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[1] });
    const res = await send(a1, task, {
      mode: 'craft',
      content: '',
      skillId: 'care-plan',
      planOptions: OPTIONS,
    }).expect(409);
    expect(JSON.stringify(res.body)).toContain('no_plan_data');
    expect(provider.calls).toHaveLength(0);
  });

  it('方案选项不合法：400，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    for (const planOptions of [{ sections: [] }, { cycleWeeks: 6 }]) {
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'care-plan',
        planOptions,
      }).expect(400);
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('跨租户访问被拒绝：别人的任务、别人的客户 → 404，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    for (const u of [f.users.managerA2, f.users.managerB1]) {
      const other = await as(u.email);
      await send(other, task, { mode: 'craft', content: '', skillId: 'care-plan' }).expect(404);
    }
    for (const other of [f.clients.a2, f.clients.b1]) {
      const t = await newTask(a1);
      await send(a1, t, {
        mode: 'craft',
        content: '',
        skillId: 'care-plan',
        clientRefs: [other],
      }).expect(404);
    }
    expect(provider.calls).toHaveLength(0);
  });
});
