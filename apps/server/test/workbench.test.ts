import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { DISCLAIMER, type TaskStreamEvent } from '@health-buddy/shared';
import { ASK_NOTICE, CRISIS_NOTICE } from '@health-buddy/skills';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { insertDraft, insertTask, type Scope } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

interface Script {
  chunks?: string[];
  finishReason?: 'complete' | 'refused';
  delayMs?: number;
}

/** 按测试需要排队的模拟厂商，记录每次收到的请求 */
class ScriptedProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  queue: Script[] = [];

  async *stream(
    req: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const script = this.queue.shift() ?? { chunks: ['好的。'] };
    for (const delta of script.chunks ?? []) {
      await new Promise((r) => setTimeout(r, script.delayMs ?? 0));
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text', delta };
    }
    yield {
      type: 'done',
      finishReason: script.finishReason ?? 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }
}

const summaryJson = (
  clientFacing = '您好，您最近的血压比较平稳，继续保持规律作息。有疑问请联系您的健管师。',
) =>
  JSON.stringify({
    professional: {
      overview: '该客户近 30 天收缩压平稳。',
      findings: [],
      suggestions: ['两周后复测血压'],
      referralAdvice: null,
      missingData: [],
    },
    clientFacing,
    crisisSignal: false,
  });

function parseSse(text: string): TaskStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as TaskStreamEvent);
}

describe('对话和生成接口', () => {
  const owner = ownerDb();
  const provider = new ScriptedProvider();
  let app: INestApplication;
  let f: Fixtures;
  const scopeA1 = (): Scope => ({
    operatorId: f.operatorA,
    orgId: f.orgA,
    managerId: f.users.managerA1.id,
  });
  const scopeB1 = (): Scope => ({
    operatorId: f.operatorB,
    orgId: f.orgB,
    managerId: f.users.managerB1.id,
  });

  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const newTask = async (agent: Agent, clientId?: string) =>
    (
      await agent
        .post('/api/tasks')
        .send(clientId ? { clientId } : {})
        .expect(201)
    ).body.task.id as string;
  const messagesOf = (taskId: string) =>
    owner
      .selectFrom('task_messages')
      .select(['role', 'content', 'status', 'mode', 'skill_id'])
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();
  const artifactsOf = (taskId: string) =>
    owner
      .selectFrom('artifacts')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('version')
      .execute();

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    provider.queue = [];
    provider.calls.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('问一问：流式回答，末尾固定加提示，历史可以再读到', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    const taskId = await newTask(agent);
    provider.queue.push({ chunks: ['多喝水', '，规律作息。'] });
    const res = await send(agent, taskId, {
      mode: 'ask',
      content: '夏天怎么保持血压平稳？',
    }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.text);
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    expect(text).toBe(`多喝水，规律作息。\n\n${ASK_NOTICE}`);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect(
      events.filter((e) => e.type === 'step').map((e) => e.type === 'step' && e.step.status),
    ).toEqual(['running', 'done']);
    expect(events.some((e) => e.type === 'artifact' || e.type === 'suggestion')).toBe(false);

    const messages = await messagesOf(taskId);
    expect(messages).toEqual([
      expect.objectContaining({ role: 'manager', status: 'complete', mode: 'ask' }),
      expect.objectContaining({ role: 'assistant', status: 'complete', content: text }),
    ]);
    const detail = await agent.get(`/api/tasks/${taskId}`).expect(200);
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.steps).toHaveLength(1);

    // 第二轮带上历史
    provider.queue.push({ chunks: ['可以。'] });
    await send(agent, taskId, { mode: 'ask', content: '那运动呢？' }).expect(200);
    expect(provider.calls.at(-1)?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('问一问引用客户：读档案、识别危急指标，提示词里没有客户姓名', async () => {
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: f.clients.a1[0],
        metric: 'sbp',
        value: 185,
        unit: 'mmHg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent);
    provider.queue.push({ chunks: ['建议尽快就医。'] });
    const res = await send(agent, taskId, {
      mode: 'ask',
      content: '测试客户 A1-1 最近血压怎么样？',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    const events = parseSse(res.text);
    const kinds = events.flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
    expect(kinds).toEqual(['read_client', 'detect_critical', 'answer']);
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
    expect(text.startsWith('**危急指标提醒**')).toBe(true);
    expect(text).toContain('收缩压 185 mmHg');

    const prompt = JSON.stringify(provider.calls[0]);
    expect(prompt).not.toContain('测试客户');
    expect(prompt).toContain('该客户');
    expect(prompt).toContain('50-59 岁');

    // 第一次引用客户后，任务归到这位客户下
    const detail = await agent.get(`/api/tasks/${taskId}`).expect(200);
    expect(detail.body.task.clientId).toBe(f.clients.a1[0]);
  });

  it('自然语言要做技能能做的事：只给技能建议，不执行', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    const taskId = await newTask(agent);
    provider.queue.push({ chunks: ['可以用近况小结技能。'] });
    const res = await send(agent, taskId, { mode: 'craft', content: '帮我写个近况小结' }).expect(
      200,
    );
    const events = parseSse(res.text);
    expect(events).toContainEqual({ type: 'suggestion', skillId: 'client-recent-summary' });
    expect(events.some((e) => e.type === 'artifact')).toBe(false);
    expect(await artifactsOf(taskId)).toHaveLength(0);
  });

  it('做一做：执行技能生成草稿，免责声明由后端拼接，危急指标写进产物', async () => {
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: f.clients.a1[0],
        metric: 'sbp',
        value: 185,
        unit: 'mmHg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: [summaryJson()] });
    const res = await send(agent, taskId, {
      mode: 'craft',
      content: '给测试客户 A1-1 写个近况小结',
      skillId: 'client-recent-summary',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    const events = parseSse(res.text);
    const artifactEvent = events.find((e) => e.type === 'artifact');
    expect(artifactEvent).toMatchObject({
      artifact: { status: 'draft', version: 1, hasCriticalFlags: true },
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });

    const [artifact] = await artifactsOf(taskId);
    expect(artifact?.status).toBe('draft');
    const content = artifact?.content as { professional: string; clientFacing: string };
    expect(content.clientFacing.endsWith(`\n\n${DISCLAIMER}`)).toBe(true);
    // 称呼由后端在模型输出之后加上，模型写的“您好”换成带客户名的问候
    expect(content.clientFacing.startsWith('测试客户 A1-1，您好！\n\n您最近的血压')).toBe(true);
    expect(content.professional).toContain('## 近况概述');
    expect(artifact?.critical_flags).toEqual([
      expect.objectContaining({
        metric: 'sbp',
        value: 185,
        rule: expect.objectContaining({ level: 'urgent' }),
      }),
    ]);
    // 技能调用用 skill 路由和结构化输出，提示词里没有姓名
    const call = provider.calls[0];
    expect(call?.route).toBe('skill');
    expect(call?.responseFormat?.name).toBe('client_recent_summary');
    expect(JSON.stringify(call)).not.toContain('测试客户');
  });

  it('健管师转述心理危机信号时，专业版顶部固定提示，通俗版不受影响', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: [summaryJson()] });
    await send(agent, taskId, {
      mode: 'craft',
      content: '客户说最近不想活了，帮我写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const [artifact] = await artifactsOf(taskId);
    const content = artifact?.content as { professional: string; clientFacing: string };
    expect(content.professional.startsWith('## 心理危机提示')).toBe(true);
    expect(content.professional).toContain(CRISIS_NOTICE);
    expect(content.clientFacing).not.toContain('危机');
  });

  it('想一想：先出计划，确认前不生成产物；确认后执行，不能重复确认', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    const res = await send(agent, taskId, {
      mode: 'plan',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const plan = parseSse(res.text).find((e) => e.type === 'plan');
    if (plan?.type !== 'plan') throw new Error('no plan');
    expect(plan.plan.steps).toEqual([
      { kind: 'read_client' },
      { kind: 'run_skill', skillId: 'client-recent-summary' },
    ]);
    expect(provider.calls).toHaveLength(0);
    expect(await artifactsOf(taskId)).toHaveLength(0);

    provider.queue.push({ chunks: [summaryJson()] });
    const confirmed = await agent
      .post(`/api/tasks/${taskId}/plans/${plan.plan.id}/confirm`)
      .expect(200);
    expect(parseSse(confirmed.text).some((e) => e.type === 'artifact')).toBe(true);
    expect(await artifactsOf(taskId)).toHaveLength(1);
    await agent.post(`/api/tasks/${taskId}/plans/${plan.plan.id}/confirm`).expect(409);
  });

  it('发新消息后，旧计划视为已修改，不能再确认', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    const res = await send(agent, taskId, {
      mode: 'plan',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const plan = parseSse(res.text).find((e) => e.type === 'plan');
    if (plan?.type !== 'plan') throw new Error('no plan');
    await send(agent, taskId, {
      mode: 'plan',
      content: '换个写法',
      skillId: 'client-recent-summary',
    }).expect(200);
    await agent.post(`/api/tasks/${taskId}/plans/${plan.plan.id}/confirm`).expect(409);
  });

  it('请求不合法返回 400：问一问带技能、未知技能、技能需要客户但没有引用', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent);
    await send(agent, taskId, {
      mode: 'ask',
      content: 'x',
      skillId: 'client-recent-summary',
    }).expect(400);
    await send(agent, taskId, { mode: 'craft', content: 'x', skillId: 'no-such-skill' }).expect(
      400,
    );
    await send(agent, taskId, {
      mode: 'craft',
      content: 'x',
      skillId: 'client-recent-summary',
    }).expect(400);
    await send(agent, taskId, { mode: 'craft', content: '' }).expect(400);
    expect(await messagesOf(taskId)).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('引用别人的客户、或任务已关联别的客户时返回 404', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent);
    for (const clientId of [f.clients.a2, f.clients.b1]) {
      await send(agent, taskId, { mode: 'ask', content: 'x', clientRefs: [clientId] }).expect(404);
    }
    const linked = await newTask(agent, f.clients.a1[0]);
    await send(agent, linked, { mode: 'ask', content: 'x', clientRefs: [f.clients.a1[1]] }).expect(
      404,
    );
    expect(await messagesOf(taskId)).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('别人的任务和产物：发消息、停止、确认计划、退回都返回 404，不调用大模型', async () => {
    const taskB = await insertTask(owner, scopeB1(), f.clients.b1);
    const artifactB = await insertDraft(owner, scopeB1(), taskB, { clientId: f.clients.b1 });
    const taskA1 = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const cases: [string, string, string][] = [
      [f.users.managerA1.email, taskB, artifactB],
      [f.users.managerA2.email, taskA1, artifactB],
    ];
    for (const [email, taskId, artifactId] of cases) {
      const agent = await loginAs(app, email);
      await send(agent, taskId, { mode: 'ask', content: 'x' }).expect(404);
      await agent.post(`/api/tasks/${taskId}/stop`).expect(404);
      await agent.post(`/api/tasks/${taskId}/plans/${crypto.randomUUID()}/confirm`).expect(404);
      await agent.post(`/api/artifacts/${artifactId}/return`).send({ reason: '重写' }).expect(404);
    }
    expect(provider.calls).toHaveLength(0);
    const status = await owner
      .selectFrom('artifacts')
      .select('status')
      .where('id', '=', artifactB)
      .executeTakeFirst();
    expect(status?.status).toBe('draft');
  });

  it('管理员角色不能使用对话接口', async () => {
    const taskA1 = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
      const agent = await loginAs(app, u.email);
      await send(agent, taskA1, { mode: 'ask', content: 'x' }).expect(404);
      await agent.post(`/api/tasks/${taskA1}/stop`).expect(404);
      await agent.post(`/api/tasks/${taskA1}/plans/${crypto.randomUUID()}/confirm`).expect(404);
      await agent
        .post(`/api/artifacts/${crypto.randomUUID()}/return`)
        .send({ reason: 'x' })
        .expect(404);
    }
    await request(app.getHttpServer()).post(`/api/tasks/${taskA1}/messages`).send({}).expect(401);
  });

  it('计划只能在它所属的任务上确认：拿别的任务（自己的或别人的）的计划返回 404', async () => {
    const planIn = async (agent: Agent, taskId: string) => {
      const res = await send(agent, taskId, {
        mode: 'plan',
        content: '写个近况小结',
        skillId: 'client-recent-summary',
      }).expect(200);
      const plan = parseSse(res.text).find((e) => e.type === 'plan');
      if (plan?.type !== 'plan') throw new Error('no plan');
      return plan.plan.id;
    };
    const agentA = await loginAs(app, f.users.managerA1.email);
    const agentB = await loginAs(app, f.users.managerB1.email);
    const taskA = await newTask(agentA, f.clients.a1[0]);
    const otherTaskA = await newTask(agentA, f.clients.a1[1]);
    const planA = await planIn(agentA, taskA);
    const planB = await planIn(agentB, await newTask(agentB, f.clients.b1));

    await agentA.post(`/api/tasks/${otherTaskA}/plans/${planA}/confirm`).expect(404);
    await agentA.post(`/api/tasks/${taskA}/plans/${planB}/confirm`).expect(404);
    expect(provider.calls).toHaveLength(0);
    const statuses = await owner
      .selectFrom('task_plans')
      .select('status')
      .where('id', 'in', [planA, planB])
      .execute();
    expect(statuses.map((p) => p.status)).toEqual(['proposed', 'proposed']);
  });

  it('别人停止不了我正在进行的生成', async () => {
    const agentB = await loginAs(app, f.users.managerB1.email);
    const agentA = await loginAs(app, f.users.managerA1.email);
    const taskB = await newTask(agentB);
    provider.queue.push({ chunks: ['第一段。', '第二段。', '第三段。'], delayMs: 100 });
    const pending = send(agentB, taskB, { mode: 'ask', content: '讲讲饮食' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 120));
    await agentA.post(`/api/tasks/${taskB}/stop`).expect(404);
    const res = await pending;
    expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
  });

  it('生成过程中客户被转出：不留下产物', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: [summaryJson()], delayMs: 300 });
    const pending = send(agent, taskId, {
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).then((r) => r);
    await new Promise((r) => setTimeout(r, 120));
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const res = await pending;
    expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'error' });
    expect(await artifactsOf(taskId)).toHaveLength(0);
  });

  it('停止：生成立即中止，已生成的文本保留并带固定提示，不生成产物', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    const taskId = await newTask(agent);
    provider.queue.push({ chunks: ['第一段。', '第二段。', '第三段。', '第四段。'], delayMs: 150 });
    const pending = send(agent, taskId, { mode: 'ask', content: '讲讲饮食' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 250));
    const stopped = await agent.post(`/api/tasks/${taskId}/stop`).expect(200);
    expect(stopped.body).toEqual({ stopped: true });
    const res = await pending;
    const events = parseSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stopped' });
    const [, assistant] = await messagesOf(taskId);
    expect(assistant?.status).toBe('stopped');
    expect(assistant?.content.startsWith('第一段。')).toBe(true);
    expect(assistant?.content.endsWith(`\n\n${ASK_NOTICE}`)).toBe(true);
  });

  it('模型拒答：不生成产物，回答不保留厂商原文', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: [], finishReason: 'refused' });
    const res = await send(agent, taskId, {
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'refused' });
    expect(await artifactsOf(taskId)).toHaveLength(0);
  });

  it('模型拒答时，心理危机和危急指标提醒仍然保存给健管师，模型原文丢掉', async () => {
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: f.clients.a1[0],
        metric: 'sbp',
        value: 185,
        unit: 'mmHg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: ['厂商原文'], finishReason: 'refused' });
    const res = await send(agent, taskId, {
      mode: 'ask',
      content: '客户说活不下去了，怎么办',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'refused' });
    const [, assistant] = await messagesOf(taskId);
    expect(assistant?.status).toBe('refused');
    expect(assistant?.content).toContain(CRISIS_NOTICE);
    expect(assistant?.content).toContain('**危急指标提醒**');
    expect(assistant?.content.endsWith(ASK_NOTICE)).toBe(true);
    expect(assistant?.content).not.toContain('厂商原文');

    // 做一做被拒答也一样
    provider.queue.push({ chunks: [], finishReason: 'refused' });
    await send(agent, taskId, {
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const last = (await messagesOf(taskId)).at(-1);
    expect(last?.status).toBe('refused');
    // 危机信号来自之前的消息
    expect(last?.content).toContain(CRISIS_NOTICE);
    expect(last?.content).toContain('**危急指标提醒**');
  });

  it('之前几轮提到的危机信号和姓名、手机号：后续回答仍提示，历史发给模型前去标识', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: ['好的。'] }, { chunks: ['建议联系家属。'] });
    await send(agent, taskId, {
      mode: 'ask',
      content: '测试客户 A1-1（13812345678）说最近想死',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    const res = await send(agent, taskId, {
      mode: 'ask',
      content: '那现在怎么跟进？',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    const text = parseSse(res.text)
      .flatMap((e) => (e.type === 'text' ? [e.delta] : []))
      .join('');
    expect(text.startsWith('**心理危机提示**')).toBe(true);
    const prompt = JSON.stringify(provider.calls[1]);
    expect(prompt).not.toContain('测试客户');
    expect(prompt).not.toContain('13812345678');
    expect(prompt).toContain('[电话]');
  });

  it('输出格式不合格：重试一次仍不合格就报错，不留半成品', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: ['不是 JSON'] }, { chunks: ['{"仍然":"不对"}'] });
    const res = await send(agent, taskId, {
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const events = parseSse(res.text);
    expect(events).toContainEqual({ type: 'error', kind: 'invalid_output' });
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'error' });
    expect(res.text).not.toContain('不是 JSON');
    expect(await artifactsOf(taskId)).toHaveLength(0);
  });

  it('退回重写：旧版本改为已退回，AI 按退回原因生成新版本', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    provider.queue.push({ chunks: [summaryJson()] });
    await send(agent, taskId, {
      mode: 'craft',
      content: '写个近况小结',
      skillId: 'client-recent-summary',
    }).expect(200);
    const [v1] = await artifactsOf(taskId);
    if (!v1) throw new Error('no artifact');

    provider.queue.push({ chunks: [summaryJson('您好，您最近的血压比较平稳。')] });
    const res = await agent
      .post(`/api/artifacts/${v1.id}/return`)
      .send({ reason: '写短一点' })
      .expect(200);
    expect(parseSse(res.text).find((e) => e.type === 'artifact')).toMatchObject({
      artifact: { version: 2, status: 'draft' },
    });
    expect(JSON.stringify(provider.calls.at(-1))).toContain('写短一点');
    const [old, v2] = await artifactsOf(taskId);
    expect(old?.status).toBe('returned');
    expect(v2).toMatchObject({ parent_id: v1.id, lineage_id: v1.id, version: 2 });
    const events = await owner
      .selectFrom('artifact_events')
      .select(['action', 'reason'])
      .where('artifact_id', '=', v1.id)
      .execute();
    expect(events).toContainEqual({ action: 'returned', reason: '写短一点' });

    // 已退回的不能再退回
    await agent.post(`/api/artifacts/${v1.id}/return`).send({ reason: '再改' }).expect(409);
  });

  it('客户转出后任务只读：发消息返回 409', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const taskId = await newTask(agent, f.clients.a1[0]);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();
    const res = await send(agent, taskId, { mode: 'ask', content: 'x' }).expect(409);
    expect(res.body).toEqual({ error: 'conflict', reasons: ['read_only'] });
  });

  it('同一任务不能同时生成两次', async () => {
    const agent = await loginAs(app, f.users.managerA2.email);
    const taskId = await newTask(agent);
    provider.queue.push({ chunks: ['一', '二', '三'], delayMs: 100 });
    const first = send(agent, taskId, { mode: 'ask', content: '第一问' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    const second = await send(agent, taskId, { mode: 'ask', content: '第二问' });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'conflict', reasons: ['busy'] });
    expect((await first).status).toBe(200);
  });

  it('每位健管师每分钟第 21 次调用返回 429', async () => {
    const agent = await loginAs(app, f.users.managerA3.email);
    const taskId = await newTask(agent);
    for (let i = 0; i < 20; i++) {
      await send(agent, taskId, { mode: 'ask', content: `问题 ${i}` }).expect(200);
    }
    const res = await send(agent, taskId, { mode: 'ask', content: '第 21 个' }).expect(429);
    expect(res.body).toEqual({ error: 'too_many_requests' });
    // 别的健管师不受影响
    const other = await loginAs(app, f.users.managerB1.email);
    await send(other, await newTask(other), { mode: 'ask', content: 'x' }).expect(200);
  });
});

describe('生成过程的日志', () => {
  const owner = ownerDb();
  const provider = new ScriptedProvider();
  let app: INestApplication;
  let f: Fixtures;

  beforeAll(async () => {
    f = await seedFixtures(owner);
    // 打开全部日志级别，检查日志里没有客户数据
    app = await createTestApp({ env: 'development' }, { llmProviders: { openai: provider } });
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('日志里没有客户姓名、健康数值、提示词和回答原文', async () => {
    await owner
      .insertInto('monitoring_readings')
      .values({
        client_id: f.clients.a1[0],
        metric: 'sbp',
        value: 187,
        unit: 'mmHg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
    const written: string[] = [];
    const capture = (stream: NodeJS.WriteStream) => {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        written.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      return () => {
        stream.write = original;
      };
    };
    const restore = [capture(process.stdout), capture(process.stderr)];
    try {
      const agent = await loginAs(app, f.users.managerA1.email);
      const taskId = (await agent.post('/api/tasks').send({ clientId: f.clients.a1[0] })).body.task
        .id as string;
      provider.queue.push({ chunks: ['不是 JSON'] }, { chunks: [summaryJson('您好，近况平稳。')] });
      await agent
        .post(`/api/tasks/${taskId}/messages`)
        .send({
          mode: 'craft',
          content: '给测试客户 A1-1 写个近况小结，她说不想活了',
          skillId: 'client-recent-summary',
        })
        .expect(200);
      provider.queue.push({ chunks: ['回答原文片段'] });
      await agent
        .post(`/api/tasks/${taskId}/messages`)
        .send({ mode: 'ask', content: '测试客户 A1-1 的血压呢' })
        .expect(200);
    } finally {
      restore.forEach((r) => r());
    }
    const log = written.join('');
    expect(log).toContain('artifact drafted');
    for (const secret of ['测试客户', '187', '不想活', '近况平稳', '回答原文片段', '不是 JSON']) {
      expect(log, secret).not.toContain(secret);
    }
  });
});
