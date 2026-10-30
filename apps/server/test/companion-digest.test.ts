import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M6 第 6b-2 步：/随访话术、问一问、“伴侣跟进”计划读伴侣“福宝”的信息（规格 2.7、2.8、Q25）。
 * 提示词里有近 14 天的收集信息和未处理的转交（去掉姓名、电话），产物里只有条数、不写原话；
 * 没有开通伴侣时计划 409；客户转出后资料跟着客户走。全部是合成数据。
 */
describe('工作台读伴侣信息', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  let app: INestApplication;
  let f: Fixtures;

  const as = (email: string) => loginAs(app, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const stepKinds = (text: string) =>
    parseSse(text).flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
  const prompt = () => JSON.stringify(provider.calls.at(-1)!.messages);

  const tenantOf = (clientId: string) =>
    owner
      .selectFrom('clients')
      .select(['operator_id', 'org_id', 'manager_id'])
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
  /** 用所有者身份写福宝整理的收集信息和转交（相当于会话结束后的整理） */
  const seedCompanion = async (clientId: string) => {
    const t = await tenantOf(clientId);
    const today = new Date().toISOString().slice(0, 10);
    await owner
      .insertInto('companion_observations')
      .values([
        {
          ...t,
          client_id: clientId,
          category: 'sleep',
          polarity: 'negative',
          text: '测试客户 A1-1 说这几天夜里醒两三次，电话 13812345678',
          observed_on: today,
        },
        {
          ...t,
          client_id: clientId,
          category: 'diet',
          text: '客户说晚饭改吃半碗杂粮饭',
          observed_on: today,
        },
      ])
      .execute();
    await owner
      .insertInto('companion_handoffs')
      .values({
        ...t,
        client_id: clientId,
        category: 'medication',
        question: '合成：药物能不能少吃一点',
        trigger: 'rule',
      })
      .execute();
  };

  const scriptReply = {
    json: {
      summary: { changes: [], adherence: [], followUps: [], agreements: [] },
      opening: '您好，今天想和您聊聊最近的睡眠。',
      questions: [
        { section: 'routine', question: '最近晚上睡得怎么样？', why: '福宝记录到夜里醒' },
        { section: 'diet', question: '晚饭一般吃些什么？', why: '了解饮食' },
        { section: 'exercise', question: '这周出去走了吗？', why: '了解运动' },
      ],
      encouragement: [],
      adjustments: [],
      reminders: [],
      notes: [],
      crisisSignal: false,
    },
  };

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    provider.reset();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('/随访话术：读伴侣信息，提示词里有原句（去掉姓名、电话）；草稿的伴侣对话要点只有条数，没有原话', async () => {
    const a1 = await as(f.users.managerA1.email);
    await seedCompanion(f.clients.a1[0]);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = scriptReply;
    const res = await send(a1, task, { mode: 'craft', content: '', skillId: 'visit-script' });
    expect(res.status, res.text).toBe(200);
    expect(stepKinds(res.text)).toContain('read_companion');
    const text = prompt();
    expect(text).toContain('伴侣“福宝”收集的信息');
    expect(text).toContain('夜里醒两三次');
    expect(text).toContain('药物能不能少吃一点');
    expect(text).not.toContain('测试客户');
    expect(text).not.toContain('13812345678');
    const artifact = await owner
      .selectFrom('artifacts')
      .select('content')
      .where('task_id', '=', task)
      .executeTakeFirstOrThrow();
    const professional = (artifact.content as { professional: string }).professional;
    expect(professional).toContain('**伴侣对话要点**');
    expect(professional).toContain('睡眠 1 条（消极 1 条）');
    expect(professional).toContain('未处理的转交：1 个（用药）');
    expect(professional).not.toContain('夜里醒两三次');
    expect(professional).not.toContain('药物能不能少吃一点');
  });

  it('/随访话术：没有开通伴侣时写明，提示词里也写明', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[1] });
    provider.scripts.skill = scriptReply;
    await send(a1, task, { mode: 'craft', content: '', skillId: 'visit-script' }).expect(200);
    expect(prompt()).toContain('客户没有开通伴侣“福宝”');
    const artifact = await owner
      .selectFrom('artifacts')
      .select('content')
      .where('task_id', '=', task)
      .executeTakeFirstOrThrow();
    expect((artifact.content as { professional: string }).professional).toContain(
      '客户没有开通伴侣“福宝”',
    );
  });

  it('问一问：引用了开通伴侣的客户时读伴侣信息；没有开通的不读、不显示这一步', async () => {
    const a1 = await as(f.users.managerA1.email);
    await seedCompanion(f.clients.a1[0]);
    provider.scripts.chat = { text: '合成回答' };
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, { mode: 'ask', content: '最近睡眠怎么样' }).expect(200);
    expect(stepKinds(res.text)).toContain('read_companion');
    expect(prompt()).toContain('夜里醒两三次');
    expect(JSON.stringify(provider.calls.at(-1)!.system)).toContain('伴侣“福宝”的信息');

    provider.reset();
    provider.scripts.chat = { text: '合成回答' };
    const other = await newTask(a1, { clientId: f.clients.a1[1] });
    const res2 = await send(a1, other, { mode: 'ask', content: '最近怎么样' }).expect(200);
    expect(stepKinds(res2.text)).not.toContain('read_companion');
    expect(prompt()).not.toContain('伴侣“福宝”收集的信息');
  });

  it('“伴侣跟进”计划：没有开通伴侣 409 no_companion，不调用模型；开通了的计划有读取伴侣信息这一步', async () => {
    const a1 = await as(f.users.managerA1.email);
    const none = await newTask(a1, { clientId: f.clients.a1[1] });
    const res = await send(a1, none, {
      mode: 'plan',
      content: '',
      skillId: 'companion-follow-up',
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('no_companion');
    expect(provider.calls).toHaveLength(0);

    await seedCompanion(f.clients.a1[0]);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const ok = await send(a1, task, {
      mode: 'plan',
      content: '',
      skillId: 'companion-follow-up',
    }).expect(200);
    const plan = parseSse(ok.text).find((e) => e.type === 'plan') as
      { plan: { steps: { kind: string; skillId?: string }[] } } | undefined;
    expect(plan!.plan.steps).toEqual([
      { kind: 'read_client' },
      { kind: 'read_twin' },
      { kind: 'read_companion' },
      { kind: 'run_skill', skillId: 'visit-script' },
    ]);
  });

  it('跨租户：别人的客户 404；客户转出后伴侣信息跟着客户走，新健管师读得到，原健管师读不到', async () => {
    await seedCompanion(f.clients.a1[0]);
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
    ]) {
      const agent = await as(email);
      const task = await newTask(agent);
      await send(agent, task, {
        mode: 'ask',
        content: '最近睡眠怎么样',
        clientRefs: [f.clients.a1[0]],
      }).expect(404);
      // /随访话术、“伴侣跟进”计划引用别人的客户同样 404（不会借 409 no_companion 探测别人的客户）
      await send(agent, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-script',
        clientRefs: [f.clients.a1[0]],
      }).expect(404);
      await send(agent, task, {
        mode: 'plan',
        content: '',
        skillId: 'companion-follow-up',
        clientRefs: [f.clients.a1[0]],
      }).expect(404);
    }
    expect(provider.calls).toHaveLength(0);

    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    // 原健管师引用这位客户 → 404，不调用模型
    const a1 = await as(f.users.managerA1.email);
    const old = await newTask(a1);
    await send(a1, old, {
      mode: 'ask',
      content: '最近睡眠怎么样',
      clientRefs: [f.clients.a1[0]],
    }).expect(404);
    expect(provider.calls).toHaveLength(0);
    const a2 = await as(f.users.managerA2.email);
    provider.scripts.chat = { text: '合成回答' };
    const task = await newTask(a2, { clientId: f.clients.a1[0] });
    await send(a2, task, { mode: 'ask', content: '最近睡眠怎么样' }).expect(200);
    expect(prompt()).toContain('夜里醒两三次');
  });
});
