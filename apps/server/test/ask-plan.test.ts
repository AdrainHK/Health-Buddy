import { ASK_PLAN_RULES } from '@health-buddy/skills';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * 问一问读方案、随访和方案库（M5 规格 2.11）：引用客户时读当前方案、执行情况、随访记录；问到吃什么时
 * 读按过敏史筛过的候选；@食谱、@动作 读这个条目，过敏原和运动安全规则由后端算好。看不到的条目 404，
 * 不调用模型。全部是合成数据。
 */
describe('问一问读方案和方案库', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  let app: INestApplication;
  let preview: INestApplication;
  let f: Fixtures;
  const lib: Record<string, string> = {};

  const as = (email: string, target = app) => loginAs(target, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const stepKinds = (text: string) =>
    parseSse(text).flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
  const lastCall = () => provider.calls.at(-1)!;
  const prompt = () => JSON.stringify(lastCall().messages);

  const published = {
    status: 'published',
    reviewed_by_label: '合成审定人',
    reviewed_on: '2026-10-01',
    source_note: '合成',
  };

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
    const recipe = (code: string, name: string, allergens: string[], extra = {}) =>
      upsert('plan_library_recipes', code, {
        name,
        meal_types: ['breakfast'],
        ingredients: JSON.stringify([{ name: '燕麦', householdAmount: '半碗' }]),
        steps: JSON.stringify(['煮开']),
        allergens,
        ...extra,
      });
    lib.oat = await recipe('ask-test-oat', '合成燕麦粥', []);
    lib.peanut = await recipe('ask-test-peanut', '合成花生拌面', ['peanut']);
    lib.review = await recipe('ask-test-review', '合成待审定早餐', [], {
      status: 'review',
      reviewed_by_label: null,
      reviewed_on: null,
    });
    lib.walk = await upsert('plan_library_exercises', 'ask-test-walk', {
      name: '合成快走',
      category: 'aerobic',
      intensity: 'low',
      setting: ['home'],
      steps: JSON.stringify(['慢慢走']),
      key_points: JSON.stringify(['放松肩膀']),
      manager_cautions: '合成注意事项',
    });
  }

  const allergic = (clientId: string) =>
    owner
      .insertInto('client_health_history')
      .values({
        client_id: clientId,
        category: 'allergy',
        content: '花生过敏',
        created_by: f.users.managerA1.id,
      } as never)
      .execute();

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
    preview = await createTestApp(
      { planLibraryPreview: true },
      { llmProviders: { openai: provider } },
    );
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    await seedLibrary();
    provider.reset();
  });

  afterAll(async () => {
    await app.close();
    await preview.close();
    await owner.destroy();
  });

  it('引用客户：读当前方案、执行情况和随访记录，系统提示词带方案规则；不问吃什么时不带候选', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, { mode: 'ask', content: '测试客户 A1-1 的方案执行得怎么样' });
    expect(res.status).toBe(200);
    expect(stepKinds(res.text)).toEqual([
      'read_client',
      'detect_critical',
      'read_twin',
      'read_care_plan',
      'answer',
    ]);
    expect(prompt()).toContain('## 当前方案');
    expect(prompt()).toContain('没有生效的方案');
    expect(prompt()).toContain('## 最近的随访记录');
    expect(prompt()).not.toContain('测试客户');
    expect(prompt()).not.toContain('合成燕麦粥');
    expect(lastCall().system).toContain(ASK_PLAN_RULES);
  });

  it('随访记录里的客户姓名去标识后才进提示词；记录里的急症描述让 @动作 按需先就医评估处理', async () => {
    const client = await owner
      .selectFrom('clients')
      .select(['operator_id', 'org_id', 'manager_id', 'display_name'])
      .where('id', '=', f.clients.a1[0])
      .executeTakeFirstOrThrow();
    await owner
      .insertInto('visit_records')
      .values({
        operator_id: client.operator_id,
        org_id: client.org_id,
        manager_id: client.manager_id,
        client_id: f.clients.a1[0],
        visit_date: '2026-10-15',
        method: 'phone',
        snapshot: JSON.stringify({
          visitDate: '2026-10-15',
          method: 'phone',
          summary: `${client.display_name}说最近散步时胸痛。`,
          feedback: [],
          planProgress: [],
          agreements: ['周末也散步'],
          attentionPoints: [],
          historySuggestions: [],
          openQuestions: [],
        }),
        approved_by: f.users.managerA1.id,
      } as never)
      .execute();
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    await send(a1, task, {
      mode: 'ask',
      content: '这个合适吗',
      libraryRefs: [{ type: 'exercise', id: lib.walk }],
    }).expect(200);
    expect(prompt()).toContain('说最近散步时胸痛');
    expect(prompt()).not.toContain(client.display_name);
    expect(prompt()).toContain('运动安全规则（系统判断）**：有疑似急症信号');
  });

  it('问吃什么：读按过敏史筛过的候选（排除花生），待审定的条目在正式环境不列', async () => {
    await allergic(f.clients.a1[0]);
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, { mode: 'ask', content: '这位客户早餐适合吃什么' });
    expect(res.status).toBe(200);
    expect(stepKinds(res.text)).toContain('select_library_items');
    expect(prompt()).toContain('合成燕麦粥');
    expect(prompt()).not.toContain('合成花生拌面');
    expect(prompt()).not.toContain('合成待审定早餐');
  });

  it('@食谱、@动作：读条目全部内容；和客户过敏史冲突时写明；消息上记下引用', async () => {
    await allergic(f.clients.a1[0]);
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, {
      mode: 'ask',
      content: '这两个合适吗',
      libraryRefs: [
        { type: 'recipe', id: lib.peanut },
        { type: 'exercise', id: lib.walk },
      ],
    });
    expect(res.status).toBe(200);
    expect(prompt()).toContain('### 食谱：合成花生拌面');
    expect(prompt()).toContain('过敏原提示');
    expect(prompt()).toContain('### 有氧：合成快走');
    expect(prompt()).toContain('合成注意事项');
    // 健康史原文只用来比对，不进提示词
    expect(prompt()).not.toContain('花生过敏');
    const detail = (await a1.get(`/api/tasks/${task}`).expect(200)).body;
    const manager = detail.messages.find((m: { role: string }) => m.role === 'manager');
    expect(manager.libraryRefs).toEqual([
      { type: 'recipe', id: lib.peanut },
      { type: 'exercise', id: lib.walk },
    ]);
  });

  it('没有引用客户也能 @食谱（不比对过敏史）；只能在问一问里 @（做一做 400）', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1);
    await send(a1, task, {
      mode: 'ask',
      content: '这个早餐怎么做',
      libraryRefs: [{ type: 'recipe', id: lib.peanut }],
    }).expect(200);
    expect(prompt()).toContain('合成花生拌面');
    expect(prompt()).not.toContain('过敏原提示');
    await send(a1, task, {
      mode: 'craft',
      content: '写个小结',
      skillId: 'client-recent-summary',
      libraryRefs: [{ type: 'recipe', id: lib.oat }],
    }).expect(400);
  });

  it('看不到的条目（不存在、正式环境里待审定的）→ 404，不调用模型；预览环境可以 @ 待审定的', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1);
    for (const ref of [
      { type: 'recipe', id: lib.review },
      { type: 'recipe', id: '00000000-0000-4000-8000-000000000000' },
      { type: 'exercise', id: lib.oat },
    ]) {
      await send(a1, task, { mode: 'ask', content: '怎么样', libraryRefs: [ref] }).expect(404);
    }
    expect(provider.calls).toHaveLength(0);
    const p1 = await as(f.users.managerA1.email, preview);
    const previewTask = (await p1.post('/api/tasks').send({}).expect(201)).body.task.id as string;
    await p1
      .post(`/api/tasks/${previewTask}/messages`)
      .send({ mode: 'ask', content: '怎么样', libraryRefs: [{ type: 'recipe', id: lib.review }] })
      .expect(200);
    expect(prompt()).toContain('合成待审定早餐');
  });

  it('跨租户访问被拒绝：别人的任务、别人的客户带库条目 → 404，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const b1 = await as(f.users.managerB1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    // 同机构别的健管师：在自己的任务里引用 A1 的客户
    const a2 = await as(f.users.managerA2.email);
    const own = await newTask(a2);
    await send(a2, own, {
      mode: 'ask',
      content: '怎么样',
      clientRefs: [f.clients.a1[0]],
      libraryRefs: [{ type: 'recipe', id: lib.oat }],
    }).expect(404);
    await send(b1, task, {
      mode: 'ask',
      content: '怎么样',
      libraryRefs: [{ type: 'recipe', id: lib.oat }],
    }).expect(404);
    expect(provider.calls).toHaveLength(0);
  });
});
