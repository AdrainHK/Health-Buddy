import type { TaskStreamEvent } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * 重新请专家、补请专家、10 分钟内复用意见、报告更正后的标记、“请 @专家 看看”建议
 * （M3 规格 2.5、2.6、3.7、6.4）。每个新接口都有“跨租户访问被拒绝”的测试。全部是合成数据。
 */
describe('重新请专家、补请专家和复用意见', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  const prodProvider = new ExpertProvider();
  let preview: INestApplication;
  let prod: INestApplication;
  let f: Fixtures;
  let reportA1: string;
  let indicatorA1: string;

  const as = (email: string, target = preview) => loginAs(target, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const reconsult = (agent: Agent, id: string, body: Record<string, unknown> = {}) =>
    agent.post(`/api/expert-consultations/${id}/reconsult`).send(body);
  const addExpert = (agent: Agent, id: string, body: Record<string, unknown>) =>
    agent.post(`/api/expert-consultations/${id}/add-expert`).send(body);
  const consultationsOf = (taskId: string) =>
    owner
      .selectFrom('expert_consultations')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();
  const callsOf = (consultationId: string) =>
    owner
      .selectFrom('expert_calls')
      .select(['expert_id', 'status'])
      .where('consultation_id', '=', consultationId)
      .orderBy('expert_id')
      .execute();
  const artifactsOf = (taskId: string) =>
    owner
      .selectFrom('artifacts')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();
  const expertRoutes = (p = provider) =>
    p
      .routes()
      .filter((r) => r.startsWith('expert:'))
      .sort();
  const expertUsage = async () =>
    Number(
      (
        await owner
          .selectFrom('llm_usage')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('route', '=', 'expert')
          .executeTakeFirstOrThrow()
      ).n,
    );
  const steps = (events: TaskStreamEvent[]) =>
    events.flatMap((e) => (e.type === 'step' && e.step.status !== 'running' ? [e.step] : []));

  async function insertReport(clientId: string) {
    const report = await owner
      .insertInto('health_reports')
      .values({
        client_id: clientId,
        report_date: '2026-09-12',
        title: '合成报告',
        source: 'synthetic',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const indicator = await owner
      .insertInto('report_indicators')
      .values({
        report_id: report.id,
        client_id: clientId,
        code: 'fpg',
        value: 6.5,
        unit: 'mmol/L',
        ref_low: 3.9,
        ref_high: 6.1,
        ref_text: '3.9-6.1',
        abnormal: 'high',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { reportId: report.id as string, indicatorId: indicator.id as string };
  }

  /** 健管师在问一问里 @ 专家，返回任务和这次调用 */
  async function ask(agent: Agent, expertRefs: string[], content = '空腹血糖偏高要注意什么？') {
    const taskId = await newTask(agent);
    await send(agent, taskId, { mode: 'ask', content, expertRefs }).expect(200);
    const [consultation] = await consultationsOf(taskId);
    return { taskId, consultation: consultation! };
  }

  /** /体检解读 自动请专家，返回任务、调用和草稿 */
  async function interpret(agent: Agent, extra: Record<string, unknown> = {}) {
    const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
    await send(agent, taskId, {
      mode: 'craft',
      content: '帮我解读一下这份报告',
      skillId: 'report-interpretation',
      reportRefs: [reportA1],
      ...extra,
    }).expect(200);
    const [consultation] = await consultationsOf(taskId);
    const [artifact] = await artifactsOf(taskId);
    return { taskId, consultation: consultation!, artifact: artifact! };
  }

  /** 用所有者身份给某位健管师补 n 次今天的专家调用（每次一位专家） */
  async function fillCalls(manager: { id: string }, n: number) {
    const scope = { operator_id: f.operatorA, org_id: f.orgA, manager_id: manager.id };
    const task = await owner
      .insertInto('tasks')
      .values({ ...scope, client_id: null, title: '合成任务' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const message = await owner
      .insertInto('task_messages')
      .values({
        ...scope,
        task_id: task.id,
        role: 'assistant',
        mode: 'ask',
        content: '',
        status: 'streaming',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (let i = 0; i < n; i++) {
      const c = await owner
        .insertInto('expert_consultations')
        .values({
          ...scope,
          task_id: task.id,
          message_id: message.id,
          trigger: 'mention',
          routing: JSON.stringify({ selected: [], excluded: [], overCap: [], ruleOnly: false }),
          status: 'running',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await owner
        .insertInto('expert_calls')
        .values({
          ...scope,
          consultation_id: c.id,
          expert_id: 'nutrition',
          expert_version: '0.1.0',
          sources_version: '0123456789ab',
          selected_reason: 'manager',
          status: 'running',
        })
        .execute();
    }
  }

  /** 客户转给同机构的另一位健管师：原健管师的任务变成只读 */
  const transferClient = () =>
    owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA2.id })
      .where('id', '=', f.clients.a1[0])
      .execute();

  beforeAll(async () => {
    preview = await createTestApp({ expertsPreview: true }, { llmProviders: { openai: provider } });
    prod = await createTestApp({}, { llmProviders: { openai: prodProvider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    ({ reportId: reportA1, indicatorId: indicatorA1 } = await insertReport(f.clients.a1[0]));
    for (const p of [provider, prodProvider]) p.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await preview.close();
    await prod.close();
    await owner.destroy();
  });

  describe('POST /api/expert-consultations/:id/reconsult', () => {
    it('直接请专家的调用：按原问题再请一次，生成新的调用记录和新的回答，计入用量；原记录不变', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await ask(agent, ['endocrine-metabolism', 'nutrition']);
      provider.calls.length = 0;
      const before = await expertUsage();

      const res = await reconsult(agent, consultation.id).expect(200);
      const events = parseSse(res.text);
      expect(expertRoutes()).toEqual(['expert:endocrine-metabolism', 'expert:nutrition']);
      expect(JSON.stringify(provider.calls)).toContain('空腹血糖偏高要注意什么？');
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
      expect(steps(events).map((s) => s.kind)).toEqual(['consult_experts', 'synthesize_experts']);
      expect(await expertUsage()).toBe(before + 2);

      const rows = await consultationsOf(taskId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: consultation.id, status: 'done', origin_id: null });
      expect(rows[1]).toMatchObject({
        trigger: 'mention',
        status: 'done',
        origin_id: consultation.id,
        origin_kind: 'reconsult',
        request_message_id: consultation.request_message_id,
      });
      const answers = await owner
        .selectFrom('task_messages')
        .select(['id', 'content'])
        .where('task_id', '=', taskId)
        .where('role', '=', 'assistant')
        .orderBy('created_at')
        .execute();
      expect(answers).toHaveLength(2);
      expect(rows[1]?.message_id).toBe(answers[1]?.id);
      expect(answers[1]?.content).toContain('## 专家意见汇总');

      const detail = (await agent.get(`/api/expert-consultations/${rows[1]!.id}`).expect(200)).body
        .consultation;
      expect(detail.origin).toEqual({ kind: 'reconsult', consultationId: consultation.id });
      expect(detail.reportCorrectedSince).toBe(false);
    });

    it('可以调整要请的专家；直接请的调用不能带“不要请”；不可用的专家 404；请求体不对 400', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await ask(agent, ['endocrine-metabolism', 'nutrition']);
      provider.calls.length = 0;
      await reconsult(agent, consultation.id, { excluded: ['nutrition'] }).expect(400);
      await reconsult(agent, consultation.id, { forced: [] }).expect(400);
      await reconsult(agent, consultation.id, { forced: ['nutrition', 'nutrition'] }).expect(400);
      await reconsult(agent, consultation.id, { forced: ['a', 'b', 'c', 'd'] }).expect(400);
      await reconsult(agent, consultation.id, { other: true }).expect(400);
      await reconsult(agent, consultation.id, { forced: ['no-such-expert'] }).expect(404);
      const platform = await as(f.users.platform.email);
      await platform
        .patch('/api/admin/experts/cardiovascular/availability')
        .send({ enabled: false })
        .expect(204);
      await reconsult(agent, consultation.id, { forced: ['cardiovascular'] }).expect(404);
      expect(provider.calls).toEqual([]);

      await reconsult(agent, consultation.id, { forced: ['exercise-rehab'] }).expect(200);
      expect(expertRoutes()).toEqual(['expert:exercise-rehab']);
      const rows = await consultationsOf(taskId);
      expect(await callsOf(rows[1]!.id)).toEqual([{ expert_id: 'exercise-rehab', status: 'done' }]);
    });

    it('专家中心的任务：绑定的专家始终在内', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { expertId: 'endocrine-metabolism' });
      await send(agent, taskId, { mode: 'ask', content: '血糖怎么看？' }).expect(200);
      const [first] = await consultationsOf(taskId);
      provider.calls.length = 0;
      await reconsult(agent, first!.id, { forced: ['nutrition'] }).expect(200);
      expect(expertRoutes()).toEqual(['expert:endocrine-metabolism', 'expert:nutrition']);
      const rows = await consultationsOf(taskId);
      expect(rows[1]).toMatchObject({ trigger: 'expert_center', origin_kind: 'reconsult' });
    });

    it('/体检解读 自动调用的：重新自动选择，沿用原来的“不要请”，也可以改；草稿不变', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await interpret(agent, {
        excludedExperts: ['lab-interpretation'],
      });
      provider.calls.length = 0;
      const res = await reconsult(agent, consultation.id).expect(200);
      expect(steps(parseSse(res.text)).map((s) => s.kind)).toEqual([
        'read_client',
        'detect_critical',
        'route_experts',
        'consult_experts',
        'synthesize_experts',
      ]);
      expect(expertRoutes()).toEqual(['expert:endocrine-metabolism', 'expert:nutrition']);
      expect(provider.routes()).not.toContain('report_interpretation');
      let rows = await consultationsOf(taskId);
      expect(rows[1]).toMatchObject({
        trigger: 'skill_auto',
        origin_kind: 'reconsult',
        report_id: reportA1,
      });
      expect(rows[1]?.routing).toMatchObject({ excluded: ['lab-interpretation'] });
      expect(await artifactsOf(taskId)).toHaveLength(1);

      provider.calls.length = 0;
      await reconsult(agent, consultation.id, { excluded: [] }).expect(200);
      expect(expertRoutes()).toContain('expert:lab-interpretation');
      rows = await consultationsOf(taskId);
      expect(rows).toHaveLength(3);
    });

    it('跨租户访问被拒绝：别人的调用 404（同机构、别的机构、别的协会、各级管理员），不调用任何模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const { taskId, consultation } = await ask(a1, ['nutrition']);
      provider.calls.length = 0;
      for (const u of [
        f.users.managerA2,
        f.users.managerA3,
        f.users.managerB1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const other = await as(u.email);
        await reconsult(other, consultation.id).expect(404);
        await reconsult(other, consultation.id, { forced: ['nutrition'] }).expect(404);
      }
      await a1.post('/api/expert-consultations/not-a-uuid/reconsult').send({}).expect(404);
      await reconsult(a1, crypto.randomUUID()).expect(404);
      // 专家预览关闭时按不存在处理
      const prodAgent = await as(f.users.managerA1.email, prod);
      await reconsult(prodAgent, consultation.id).expect(404);
      expect(provider.calls).toEqual([]);
      expect(prodProvider.calls).toEqual([]);
      expect(await consultationsOf(taskId)).toHaveLength(1);
    });

    it('客户转出后任务只读：重新请专家 409，不调用模型', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await interpret(agent);
      await transferClient();
      provider.calls.length = 0;
      const res = await reconsult(agent, consultation.id).expect(409);
      expect(res.body.reasons).toContain('read_only');
      expect(provider.calls).toEqual([]);
      expect(await consultationsOf(taskId)).toHaveLength(1);
    });

    it('当天的专家调用次数不够时返回 429，不调用模型', async () => {
      const agent = await as(f.users.managerA1.email);
      const { consultation } = await ask(agent, ['endocrine-metabolism', 'nutrition']);
      const routed = await interpret(agent);
      // 已有 2 + 3 次，再补到 199 次：直接请两位超出，自动选择还剩 1 次可以请
      await fillCalls(f.users.managerA1, 194);
      provider.calls.length = 0;
      await reconsult(agent, consultation.id).expect(429);
      expect(provider.calls).toEqual([]);
      await reconsult(agent, routed.consultation.id).expect(200);
      expect(expertRoutes()).toHaveLength(1);
      // 用完了：自动选择也 429
      provider.calls.length = 0;
      await reconsult(agent, routed.consultation.id).expect(429);
      expect(provider.calls).toEqual([]);
    });
  });

  describe('POST /api/expert-consultations/:id/add-expert', () => {
    /** 指定心血管专家 + 规则命中 3 位：检验解读专家因数量上限没请 */
    async function overCap(agent: Agent) {
      const run = await interpret(agent, { expertRefs: ['cardiovascular'] });
      expect(run.consultation.routing).toMatchObject({ overCap: ['lab-interpretation'] });
      return run;
    }

    it('补请因上限没请的专家：只有这一位的新调用记录，计入每日用量', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await overCap(agent);
      provider.calls.length = 0;
      const before = await expertUsage();
      const res = await addExpert(agent, consultation.id, {
        expertId: 'lab-interpretation',
      }).expect(200);
      const events = parseSse(res.text);
      expect(steps(events).map((s) => s.kind)).toEqual([
        'read_client',
        'detect_critical',
        'consult_expert',
      ]);
      expect(provider.routes()).toEqual(['expert:lab-interpretation']);
      expect(await expertUsage()).toBe(before + 1);
      const rows = await consultationsOf(taskId);
      expect(rows[1]).toMatchObject({
        trigger: 'skill_auto',
        origin_id: consultation.id,
        origin_kind: 'add_expert',
        report_id: reportA1,
      });
      expect(await callsOf(rows[1]!.id)).toEqual([
        { expert_id: 'lab-interpretation', status: 'done' },
      ]);
      const list = (await agent.get(`/api/tasks/${taskId}/expert-consultations`).expect(200)).body
        .consultations;
      expect(list[0].origin).toEqual({ kind: 'add_expert', consultationId: consultation.id });
      // 补请的调用再重新请：仍只直接请这一位
      provider.calls.length = 0;
      await reconsult(agent, rows[1]!.id).expect(200);
      expect(provider.routes()).toEqual(['expert:lab-interpretation']);
    });

    it('只能补请因上限没请的专家：别的专家 400，请求体不对 400，暂停的专家 404', async () => {
      const agent = await as(f.users.managerA1.email);
      const { consultation } = await overCap(agent);
      provider.calls.length = 0;
      await addExpert(agent, consultation.id, { expertId: 'nutrition' }).expect(400);
      await addExpert(agent, consultation.id, { expertId: 'mental-health' }).expect(400);
      await addExpert(agent, consultation.id, {}).expect(400);
      await addExpert(agent, consultation.id, { expertId: 'Bad Id' }).expect(400);
      const platform = await as(f.users.platform.email);
      await platform
        .patch('/api/admin/experts/lab-interpretation/availability')
        .send({ enabled: false })
        .expect(204);
      await addExpert(agent, consultation.id, { expertId: 'lab-interpretation' }).expect(404);
      expect(provider.calls).toEqual([]);
    });

    it('跨租户访问被拒绝：别人的调用 404，不调用任何模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const { taskId, consultation } = await overCap(a1);
      provider.calls.length = 0;
      for (const u of [
        f.users.managerA2,
        f.users.managerA3,
        f.users.managerB1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const other = await as(u.email);
        await addExpert(other, consultation.id, { expertId: 'lab-interpretation' }).expect(404);
      }
      await a1
        .post('/api/expert-consultations/not-a-uuid/add-expert')
        .send({ expertId: 'lab-interpretation' })
        .expect(404);
      const prodAgent = await as(f.users.managerA1.email, prod);
      await addExpert(prodAgent, consultation.id, { expertId: 'lab-interpretation' }).expect(404);
      expect(provider.calls).toEqual([]);
      expect(await consultationsOf(taskId)).toHaveLength(1);
    });

    it('当天次数用完 429，不调用模型', async () => {
      const agent = await as(f.users.managerA1.email);
      const { consultation } = await overCap(agent);
      await fillCalls(f.users.managerA1, 197);
      provider.calls.length = 0;
      await addExpert(agent, consultation.id, { expertId: 'lab-interpretation' }).expect(429);
      expect(provider.calls).toEqual([]);
    });

    it('只读任务补请 409', async () => {
      const agent = await as(f.users.managerA1.email);
      const { consultation } = await overCap(agent);
      await transferClient();
      provider.calls.length = 0;
      const res = await addExpert(agent, consultation.id, {
        expertId: 'lab-interpretation',
      }).expect(409);
      expect(res.body.reasons).toContain('read_only');
      expect(provider.calls).toEqual([]);
    });
  });

  describe('10 分钟内复用意见（规格 3.7）', () => {
    it('问一问：同样的问题、同样的专家沿用上次的意见，步骤写明时间，不新建调用、不计用量', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await ask(agent, ['nutrition'], '晚饭怎么吃？');
      provider.calls.length = 0;
      const before = await expertUsage();
      const res = await send(agent, taskId, {
        mode: 'ask',
        content: '晚饭怎么吃？',
        expertRefs: ['nutrition'],
      }).expect(200);
      const reused = steps(parseSse(res.text)).find((s) => s.kind === 'consult_expert');
      expect(reused).toMatchObject({
        labelKey: 'steps.reuseRecentExperts',
        expertIds: ['nutrition'],
        status: 'done',
      });
      expect(reused?.labelTime).toBe(new Date(consultation.created_at).toISOString());
      expect(provider.calls).toEqual([]);
      expect(await expertUsage()).toBe(before);
      expect(await consultationsOf(taskId)).toHaveLength(1);
      const answers = await owner
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', taskId)
        .where('role', '=', 'assistant')
        .orderBy('created_at')
        .execute();
      expect(answers[1]?.content).toBe(answers[0]?.content);
      // 刷新后步骤里的时间仍在
      const detail = (await agent.get(`/api/tasks/${taskId}`).expect(200)).body;
      expect(
        detail.steps.find((s: { labelKey: string }) => s.labelKey === 'steps.reuseRecentExperts')
          ?.labelTime,
      ).toBe(reused?.labelTime);
    });

    it('问题不同、专家不同、超过 10 分钟、重新请专家时都重新调用', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await ask(agent, ['nutrition'], '晚饭怎么吃？');
      provider.calls.length = 0;
      await send(agent, taskId, {
        mode: 'ask',
        content: '早饭怎么吃？',
        expertRefs: ['nutrition'],
      }).expect(200);
      await send(agent, taskId, {
        mode: 'ask',
        content: '晚饭怎么吃？',
        expertRefs: ['nutrition', 'endocrine-metabolism'],
      }).expect(200);
      expect(expertRoutes()).toEqual([
        'expert:endocrine-metabolism',
        'expert:nutrition',
        'expert:nutrition',
      ]);
      provider.calls.length = 0;
      await reconsult(agent, consultation.id).expect(200);
      expect(expertRoutes()).toEqual(['expert:nutrition']);

      provider.calls.length = 0;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await send(agent, taskId, {
        mode: 'ask',
        content: '晚饭怎么吃？',
        expertRefs: ['nutrition'],
      }).expect(200);
      expect(expertRoutes()).toEqual(['expert:nutrition']);
    });

    it('/体检解读：同样的要求沿用上次的意见，草稿指向那次调用；报告更正后不再沿用', async () => {
      const agent = await as(f.users.managerA1.email);
      const first = await interpret(agent);
      provider.calls.length = 0;
      const res = await send(agent, first.taskId, {
        mode: 'craft',
        content: '帮我解读一下这份报告',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
      }).expect(200);
      expect(expertRoutes()).toEqual([]);
      expect(provider.routes()).toEqual(['report_interpretation']);
      const reused = steps(parseSse(res.text)).find((s) => s.kind === 'consult_experts');
      expect(reused).toMatchObject({ labelKey: 'steps.reuseRecentExperts' });
      const artifacts = await artifactsOf(first.taskId);
      expect(artifacts[1]?.consultation_id).toBe(first.consultation.id);

      await agent
        .post(`/api/reports/${reportA1}/indicators/${indicatorA1}/correct`)
        .send({ rawValue: '6.3', rawUnit: 'mmol/L' })
        .expect(200);
      provider.calls.length = 0;
      await send(agent, first.taskId, {
        mode: 'craft',
        content: '帮我解读一下这份报告',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
      }).expect(200);
      expect(expertRoutes().length).toBeGreaterThan(0);
    });
  });

  describe('报告更正和退回重写（规格 2.5、Q21）', () => {
    it('报告更正后旧意见标“基于更正前的数值”，退回重写自动重新请专家', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation, artifact } = await interpret(agent, {
        excludedExperts: ['lab-interpretation'],
      });
      const before = (await agent.get(`/api/expert-consultations/${consultation.id}`).expect(200))
        .body.consultation;
      expect(before.reportCorrectedSince).toBe(false);

      await agent
        .post(`/api/reports/${reportA1}/indicators/${indicatorA1}/correct`)
        .send({ rawValue: '6.3', rawUnit: 'mmol/L' })
        .expect(200);
      const after = (await agent.get(`/api/expert-consultations/${consultation.id}`).expect(200))
        .body.consultation;
      expect(after.reportCorrectedSince).toBe(true);
      const list = (await agent.get(`/api/tasks/${taskId}/expert-consultations`).expect(200)).body
        .consultations;
      expect(list[0].reportCorrectedSince).toBe(true);

      provider.calls.length = 0;
      await agent
        .post(`/api/artifacts/${artifact.id}/return`)
        .send({ reason: '数值更正了，请重新写' })
        .expect(200);
      expect(expertRoutes()).toEqual(['expert:endocrine-metabolism', 'expert:nutrition']);
      const rows = await consultationsOf(taskId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ origin_id: consultation.id, origin_kind: 'reconsult' });
      // 沿用原来的“不要请”
      expect(rows[1]?.routing).toMatchObject({ excluded: ['lab-interpretation'] });
      const versions = await artifactsOf(taskId);
      expect(versions[1]?.consultation_id).toBe(rows[1]?.id);
      const fresh = (await agent.get(`/api/expert-consultations/${rows[1]!.id}`).expect(200)).body
        .consultation;
      expect(fresh.reportCorrectedSince).toBe(false);
    });

    it('退回重写带 reconsult: true 时重新请专家，新的草稿指向新的调用', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation, artifact } = await interpret(agent);
      provider.calls.length = 0;
      await agent
        .post(`/api/artifacts/${artifact.id}/return`)
        .send({ reason: '请重新请专家', reconsult: true })
        .expect(200);
      expect(expertRoutes().length).toBeGreaterThan(0);
      const rows = await consultationsOf(taskId);
      expect(rows[1]).toMatchObject({ origin_id: consultation.id, origin_kind: 'reconsult' });
      expect((await artifactsOf(taskId))[1]?.consultation_id).toBe(rows[1]?.id);
      // 不带时默认沿用（原有行为）
      const latest = (await artifactsOf(taskId))[1]!;
      provider.calls.length = 0;
      await agent
        .post(`/api/artifacts/${latest.id}/return`)
        .send({ reason: '再具体一些', reconsult: false })
        .expect(200);
      expect(expertRoutes()).toEqual([]);
    });

    it('退回重写 reconsult: true：专家预览关闭 400，次数用完 429，请求体不对 400，别人的产物 404', async () => {
      const agent = await as(f.users.managerA1.email);
      const { artifact } = await interpret(agent);
      await agent
        .post(`/api/artifacts/${artifact.id}/return`)
        .send({ reason: '原因', reconsult: 'yes' })
        .expect(400);
      const prodAgent = await as(f.users.managerA1.email, prod);
      await prodAgent
        .post(`/api/artifacts/${artifact.id}/return`)
        .send({ reason: '原因', reconsult: true })
        .expect(400);
      for (const u of [f.users.managerA2, f.users.managerB1]) {
        const other = await as(u.email);
        await other
          .post(`/api/artifacts/${artifact.id}/return`)
          .send({ reason: '原因', reconsult: true })
          .expect(404);
      }
      await fillCalls(f.users.managerA1, 200);
      provider.calls.length = 0;
      await agent
        .post(`/api/artifacts/${artifact.id}/return`)
        .send({ reason: '原因', reconsult: true })
        .expect(429);
      expect(provider.calls).toEqual([]);
      const [current] = await artifactsOf((await consultationsOf(artifact.task_id))[0]!.task_id);
      expect(current?.status).toBe('draft');
    });
  });

  describe('主对话问一问的“请 @专家 看看”建议（Q6）', () => {
    it('问题明显属于某位专家时只建议，不调用专家；正式环境不建议', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      const res = await send(agent, taskId, {
        mode: 'ask',
        content: '空腹血糖偏高要注意什么？',
      }).expect(200);
      expect(parseSse(res.text)).toContainEqual({
        type: 'expert_suggestion',
        expertId: 'endocrine-metabolism',
      });
      expect(provider.routes()).toEqual(['chat']);
      expect(await consultationsOf(taskId)).toEqual([]);

      const other = await send(agent, taskId, { mode: 'ask', content: '下周的安排？' }).expect(200);
      expect(parseSse(other.text).some((e) => e.type === 'expert_suggestion')).toBe(false);

      const prodAgent = await as(f.users.managerA1.email, prod);
      const prodTask = await newTask(prodAgent);
      const prodRes = await send(prodAgent, prodTask, {
        mode: 'ask',
        content: '空腹血糖偏高要注意什么？',
      }).expect(200);
      expect(parseSse(prodRes.text).some((e) => e.type === 'expert_suggestion')).toBe(false);
    });

    it('被平台暂停的专家不建议', async () => {
      const platform = await as(f.users.platform.email);
      await platform
        .patch('/api/admin/experts/endocrine-metabolism/availability')
        .send({ enabled: false })
        .expect(204);
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      const res = await send(agent, taskId, {
        mode: 'ask',
        content: '空腹血糖偏高要注意什么？',
      }).expect(200);
      expect(parseSse(res.text).some((e) => e.type === 'expert_suggestion')).toBe(false);
    });
  });
});
