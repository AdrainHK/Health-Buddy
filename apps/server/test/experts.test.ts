import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { EXPERT_DISCLAIMER, type ExpertOpinion, type TaskStreamEvent } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;
type Reply = { json: unknown } | { text: string } | { fail: true } | { refused: true };

/**
 * 按用途和专家 id 回答的模拟厂商（全部是合成数据）：专家并行调用，不能按调用次序排脚本。
 * 记录每次收到的请求，用来检查发给模型的内容里没有客户姓名。
 */
class ExpertProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  /** 一个键可以给一串脚本：按次序用（模拟重试），用完后重复最后一条 */
  scripts: Record<string, Reply | Reply[]> = {};
  private readonly used = new Map<string, number>();

  reset(): void {
    this.calls.length = 0;
    this.scripts = {};
    this.used.clear();
  }

  async *stream(req: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const key = req.expertId ? `expert:${req.expertId}` : req.route;
    const script = this.scripts[key];
    const n = this.used.get(key) ?? 0;
    this.used.set(key, n + 1);
    const reply =
      (Array.isArray(script) ? script[Math.min(n, script.length - 1)] : script) ??
      DEFAULTS[req.route] ??
      ({ text: '{}' } as Reply);
    await Promise.resolve();
    if ('fail' in reply) throw Object.assign(new Error('boom'), { status: 500 });
    const usage = { inputTokens: 10, outputTokens: 10 };
    if ('refused' in reply) {
      yield { type: 'done', finishReason: 'refused', usage, model: route.model };
      return;
    }
    yield { type: 'text', delta: 'json' in reply ? JSON.stringify(reply.json) : reply.text };
    yield {
      type: 'done',
      finishReason: 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }

  routes(): string[] {
    return this.calls.map((c) => (c.expertId ? `expert:${c.expertId}` : c.route));
  }
}

/** 合格的意见：不带数值、不带引用（来源还没确认，只能 data_only） */
function opinion(summary = '该客户空腹血糖高于报告参考范围，建议关注饮食。'): ExpertOpinion {
  return {
    inScope: true,
    outOfScopeNote: null,
    summary,
    findings: [
      {
        point: '空腹血糖高于报告参考范围，比上次上升。',
        basis: 'data_only',
        dataRefs: [{ label: '空腹血糖', value: null, date: null }],
        citations: [],
      },
    ],
    suggestions: [{ text: '晚餐少吃甜食，每周快走几次。', category: 'lifestyle', citations: [] }],
    referral: { needed: false, urgency: null, to: null, reason: null },
    questionsToAsk: ['近期晚餐情况'],
    dataGaps: [],
    crisisSignal: false,
    emergencySignal: false,
  };
}

const interpretationJson = {
  professional: {
    overview: '该客户这次报告有一项高于参考范围。',
    abnormalFindings: [{ indicator: '空腹血糖', observation: '比上次有所上升。' }],
    comparison: [],
    referralAdvice: null,
    riskTier: null,
    toUnderstand: [],
    missingData: [],
    interviewPoints: ['近期饮食'],
    suggestions: ['三个月后复查空腹血糖'],
  },
  clientFacing: '您好，这次体检有一项略高于报告上的参考范围。建议晚餐少吃甜食，每周快走三次。',
  crisisSignal: false,
};

const DEFAULTS: Record<string, Reply> = {
  expert: { json: opinion() },
  expert_routing: { json: { experts: [] } },
  expert_synthesis: {
    json: {
      consensus: [
        {
          point: '空腹血糖高于报告参考范围，建议关注饮食。',
          experts: ['endocrine-metabolism', 'nutrition'],
          citations: [],
        },
      ],
      disagreements: [],
      followUpPoints: ['近期晚餐情况'],
    },
  },
  report_interpretation: { json: interpretationJson },
  chat: { text: '合成回答。' },
};

function parseSse(text: string): TaskStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as TaskStreamEvent);
}

/**
 * 专家中心接口和专家调用（M3 规格 2.3–2.7、6.4）。每个新接口都有“跨租户访问被拒绝”的测试。
 * preview 实例打开专家预览开关；prod 实例按正式环境（关闭），/体检解读 必须和 M2 一样。
 */
describe('专家中心接口和专家调用', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  const prodProvider = new ExpertProvider();
  let preview: INestApplication;
  let prod: INestApplication;
  let f: Fixtures;
  let reportA1: string;

  const as = (email: string, target = preview) => loginAs(target, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const consultationsOf = (taskId: string) =>
    owner.selectFrom('expert_consultations').selectAll().where('task_id', '=', taskId).execute();
  const artifactsOf = (taskId: string) =>
    owner
      .selectFrom('artifacts')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();

  /** 健管师 A1 在专家中心向内分泌与代谢专家提问（带 @客户），返回任务和这次调用 */
  async function askBound(agent: Agent) {
    const taskId = await newTask(agent, { expertId: 'endocrine-metabolism' });
    const res = await send(agent, taskId, {
      mode: 'ask',
      content: '测试客户 A1-1 的空腹血糖要注意什么？',
      clientRefs: [f.clients.a1[0]],
    }).expect(200);
    const consultation = (await consultationsOf(taskId))[0]!;
    return { taskId, res, consultation };
  }

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
    await owner
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
      .execute();
    return report.id as string;
  }

  beforeAll(async () => {
    preview = await createTestApp({ expertsPreview: true }, { llmProviders: { openai: provider } });
    prod = await createTestApp({}, { llmProviders: { openai: prodProvider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    reportA1 = await insertReport(f.clients.a1[0]);
    for (const p of [provider, prodProvider]) p.reset();
  });

  afterAll(async () => {
    await preview.close();
    await prod.close();
    await owner.destroy();
  });

  describe('专家列表和详情（Q1、Q2、Q11）', () => {
    it('正式环境没有可用专家；预览环境列出 6 位 review 专家，带“来源待确认”', async () => {
      const prodAgent = await as(f.users.managerA1.email, prod);
      expect((await prodAgent.get('/api/experts').expect(200)).body.experts).toEqual([]);
      await prodAgent.get('/api/experts/endocrine-metabolism').expect(404);

      const agent = await as(f.users.managerA1.email);
      const experts = (await agent.get('/api/experts').expect(200)).body.experts as {
        id: string;
        status: string;
        sourcesPending: boolean;
      }[];
      expect(experts.map((e) => e.id)).toEqual([
        'endocrine-metabolism',
        'cardiovascular',
        'nutrition',
        'exercise-rehab',
        'mental-health',
        'lab-interpretation',
      ]);
      expect(experts.every((e) => e.status === 'review' && e.sourcesPending)).toBe(true);

      const detail = (await agent.get('/api/experts/nutrition').expect(200)).body.expert;
      expect(detail).toMatchObject({ id: 'nutrition', myUsageCount: 0, cards: [] });
      expect(detail.sources.length).toBeGreaterThan(0);
      await agent.get('/api/experts/no-such-expert').expect(404);
      await agent.get('/api/experts/NOT_AN_ID').expect(404);
    });

    it('未登录 401；暂停的专家不在列表里，详情 404，@ 它 404，恢复后可用', async () => {
      await (
        await import('supertest')
      )
        .default(preview.getHttpServer())
        .get('/api/experts')
        .expect(401);
      const platform = await as(f.users.platform.email);
      await platform
        .patch('/api/admin/experts/nutrition/availability')
        .send({ enabled: false })
        .expect(204);
      const agent = await as(f.users.managerA1.email);
      const ids = (await agent.get('/api/experts').expect(200)).body.experts.map(
        (e: { id: string }) => e.id,
      );
      expect(ids).not.toContain('nutrition');
      await agent.get('/api/experts/nutrition').expect(404);
      const taskId = await newTask(agent);
      await send(agent, taskId, { mode: 'ask', content: '问题', expertRefs: ['nutrition'] }).expect(
        404,
      );
      await agent.post('/api/tasks').send({ expertId: 'nutrition' }).expect(404);
      expect(provider.calls).toEqual([]);

      await platform
        .patch('/api/admin/experts/nutrition/availability')
        .send({ enabled: true })
        .expect(204);
      await agent.get('/api/experts/nutrition').expect(200);
      const events = await owner
        .selectFrom('expert_availability_events')
        .select(['expert_id', 'action', 'actor_id'])
        .orderBy('created_at')
        .execute();
      expect(events).toEqual([
        { expert_id: 'nutrition', action: 'paused', actor_id: f.users.platform.id },
        { expert_id: 'nutrition', action: 'resumed', actor_id: f.users.platform.id },
      ]);
    });

    it('跨租户访问被拒绝：只有平台管理员能暂停专家，其他角色 403；请求体不对 400；未知专家 404', async () => {
      for (const u of [
        f.users.operatorAdminA,
        f.users.orgAdminA,
        f.users.managerA1,
        f.users.managerB1,
      ]) {
        const agent = await as(u.email);
        await agent
          .patch('/api/admin/experts/nutrition/availability')
          .send({ enabled: false })
          .expect(403);
      }
      const platform = await as(f.users.platform.email);
      await platform
        .patch('/api/admin/experts/nutrition/availability')
        .send({ enabled: 'no' })
        .expect(400);
      await platform
        .patch('/api/admin/experts/no-such-expert/availability')
        .send({ enabled: false })
        .expect(404);
      expect(await owner.selectFrom('expert_availability').selectAll().execute()).toEqual([]);
    });
  });

  describe('在专家中心提问（规格 2.3）', () => {
    it('新建绑定专家的任务；不可用的专家和非健管师都拒绝', async () => {
      const agent = await as(f.users.managerA1.email);
      const task = (await agent.post('/api/tasks').send({ expertId: 'cardiovascular' }).expect(201))
        .body.task;
      expect(task.expertId).toBe('cardiovascular');
      await agent.post('/api/tasks').send({ expertId: 'no-such-expert' }).expect(404);
      const prodAgent = await as(f.users.managerA1.email, prod);
      await prodAgent.post('/api/tasks').send({ expertId: 'cardiovascular' }).expect(404);
      const orgAdmin = await as(f.users.orgAdminA.email);
      await orgAdmin.post('/api/tasks').send({ expertId: 'cardiovascular' }).expect(404);
    });

    it('专家直接回答：不经过路由，步骤和每位专家状态推给前端，末尾固定提示，发给模型的内容不含客户姓名', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, res, consultation } = await askBound(agent);
      const events = parseSse(res.text);
      expect(provider.routes()).toEqual(['expert:endocrine-metabolism']);
      expect(JSON.stringify(provider.calls)).not.toContain('测试客户 A1-1');
      expect(provider.calls[0]?.expertId).toBe('endocrine-metabolism');

      const steps = events.flatMap((e) =>
        e.type === 'step' && e.step.status !== 'running' ? [e.step] : [],
      );
      expect(steps.map((s) => [s.kind, s.status])).toEqual([
        ['read_client', 'done'],
        ['detect_critical', 'done'],
        ['consult_expert', 'done'],
      ]);
      expect(steps[2]?.expertIds).toEqual(['endocrine-metabolism']);
      expect(
        events.flatMap((e) => (e.type === 'expert_call' ? [[e.expertId, e.status]] : [])),
      ).toEqual([
        ['endocrine-metabolism', 'running'],
        ['endocrine-metabolism', 'done'],
      ]);
      expect(events).toContainEqual({
        type: 'consultation',
        consultationId: consultation.id,
        status: 'done',
      });
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });

      expect(consultation).toMatchObject({ trigger: 'expert_center', status: 'done' });
      const answer = await owner
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', taskId)
        .where('role', '=', 'assistant')
        .executeTakeFirstOrThrow();
      expect(answer.content).toContain('**结论**');
      expect(answer.content.endsWith(EXPERT_DISCLAIMER)).toBe(true);

      // 用量计量记专家 id，不记客户和任务
      const usage = await owner.selectFrom('llm_usage').select(['route', 'expert_id']).execute();
      expect(usage).toEqual([{ route: 'expert', expert_id: 'endocrine-metabolism' }]);
    });

    it('专家全部未能回复时只给固定提示，不生成替代回答', async () => {
      provider.scripts['expert:endocrine-metabolism'] = { fail: true };
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await askBound(agent);
      expect(consultation.status).toBe('failed');
      const answer = await owner
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', taskId)
        .where('role', '=', 'assistant')
        .executeTakeFirstOrThrow();
      expect(answer.content).toBe('专家暂时无法回复，请稍后再试。');
      expect(provider.routes()).not.toContain('chat');
    });

    it('绑定专家的任务固定为问一问', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { expertId: 'endocrine-metabolism' });
      await send(agent, taskId, {
        mode: 'craft',
        content: '解读',
        skillId: 'report-interpretation',
        clientRefs: [f.clients.a1[0]],
      }).expect(400);
      expect(provider.calls).toEqual([]);
    });
  });

  describe('@专家（规格 2.4）', () => {
    it('问一问 @ 两位专家：并行调用再汇总，回答里有汇总和每位专家的意见', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      await send(agent, taskId, {
        mode: 'ask',
        content: '空腹血糖偏高要注意什么？',
        expertRefs: ['endocrine-metabolism', 'nutrition'],
      }).expect(200);
      expect(provider.routes().sort()).toEqual([
        'expert:endocrine-metabolism',
        'expert:nutrition',
        'expert_synthesis',
      ]);
      const [consultation] = await consultationsOf(taskId);
      expect(consultation).toMatchObject({ trigger: 'mention', status: 'done' });
      const answer = await owner
        .selectFrom('task_messages')
        .select('content')
        .where('task_id', '=', taskId)
        .where('role', '=', 'assistant')
        .executeTakeFirstOrThrow();
      expect(answer.content).toContain('## 专家意见汇总');
      expect(answer.content).toContain('### 营养专家');
      const manager = await owner
        .selectFrom('task_messages')
        .select(['expert_refs', 'excluded_experts'])
        .where('task_id', '=', taskId)
        .where('role', '=', 'manager')
        .executeTakeFirstOrThrow();
      expect(manager).toEqual({
        expert_refs: ['endocrine-metabolism', 'nutrition'],
        excluded_experts: [],
      });
    });

    it('不接入专家的技能、多步计划带 @专家 400；正式环境 @专家 404；都不调用模型', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      await send(agent, taskId, {
        mode: 'craft',
        content: '提纲',
        skillId: 'interview-outline',
        expertRefs: ['nutrition'],
      }).expect(400);
      await send(agent, taskId, {
        mode: 'ask',
        content: '问题',
        excludedExperts: ['nutrition'],
      }).expect(400);
      const prodAgent = await as(f.users.managerA1.email, prod);
      const prodTask = await newTask(prodAgent);
      await send(prodAgent, prodTask, {
        mode: 'ask',
        content: '问题',
        expertRefs: ['nutrition'],
      }).expect(404);
      expect(provider.calls).toEqual([]);
      expect(prodProvider.calls).toEqual([]);
    });

    it('跨租户访问被拒绝：往别人的任务里 @专家 404，不调用任何模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const taskId = await newTask(a1);
      for (const u of [f.users.managerA2, f.users.managerB1, f.users.managerA3]) {
        const other = await as(u.email);
        await send(other, taskId, {
          mode: 'ask',
          content: '问题',
          expertRefs: ['nutrition'],
        }).expect(404);
      }
      expect(provider.calls).toEqual([]);
      expect(await consultationsOf(taskId)).toEqual([]);
    });

    it('每日专家调用次数用完后 @专家 返回 429', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      const remaining = 200;
      await send(agent, taskId, {
        mode: 'ask',
        content: '问题',
        expertRefs: ['nutrition'],
      }).expect(200);
      const first = (await consultationsOf(taskId))[0]!;
      const scope = { operator_id: f.operatorA, org_id: f.orgA, manager_id: f.users.managerA1.id };
      // 用所有者身份补 198 次“今天的专家调用”
      for (let i = 0; i < remaining - 2; i++) {
        const c = await owner
          .insertInto('expert_consultations')
          .values({
            ...scope,
            task_id: taskId,
            message_id: first.message_id,
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
      // 今天已有 199 次专家调用：再请两位就超出 200 次
      provider.calls.length = 0;
      await send(agent, taskId, {
        mode: 'ask',
        content: '问题',
        expertRefs: ['nutrition', 'cardiovascular'],
      }).expect(429);
      expect(provider.calls).toEqual([]);
    });
  });

  describe('/体检解读 接入专家（规格 2.5、2.7）', () => {
    const interpret = (agent: Agent, taskId: string, extra: Record<string, unknown> = {}) =>
      send(agent, taskId, {
        mode: 'craft',
        content: '帮我解读一下这份报告',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
        ...extra,
      }).expect(200);

    it('正式环境（预览关闭）和 M2 完全一样：不调用专家，不出现专家内容', async () => {
      const agent = await as(f.users.managerA1.email, prod);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      const res = await interpret(agent, taskId);
      expect(prodProvider.routes()).toEqual(['report_interpretation']);
      expect(res.text).not.toContain('专家');
      const [artifact] = await artifactsOf(taskId);
      expect(artifact?.consultation_id).toBeNull();
      expect(JSON.stringify(artifact?.content)).not.toContain('专家');
      expect(await consultationsOf(taskId)).toEqual([]);
      const skills = (await agent.get('/api/skills').expect(200)).body.skills as {
        id: string;
        experts: string;
      }[];
      expect(skills.find((s) => s.id === 'report-interpretation')?.experts).toBe('none');
    });

    it('预览环境：按规则选专家，汇总和分歧写进专业版，通俗版不出现专家；退回重写复用专家意见', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      const res = await interpret(agent, taskId, { excludedExperts: ['lab-interpretation'] });
      const events = parseSse(res.text);
      const kinds = events.flatMap((e) =>
        e.type === 'step' && e.step.status !== 'running' ? [e.step.kind] : [],
      );
      expect(kinds).toEqual([
        'read_report',
        'compare_reports',
        'detect_critical',
        'route_experts',
        'consult_experts',
        'synthesize_experts',
        'run_skill',
      ]);
      // 空腹血糖高于参考范围：规则命中内分泌和营养；检验解读被“不要请”排除
      const routes = provider.routes();
      expect(routes.filter((r) => r.startsWith('expert:')).sort()).toEqual([
        'expert:endocrine-metabolism',
        'expert:nutrition',
      ]);
      expect(routes.at(-1)).toBe('report_interpretation');
      const skillCall = provider.calls.at(-1)!;
      expect(JSON.stringify(skillCall.messages)).toContain('AI 专家意见');
      expect(JSON.stringify(provider.calls)).not.toContain('测试客户 A1-1');

      const [consultation] = await consultationsOf(taskId);
      expect(consultation).toMatchObject({ trigger: 'skill_auto', status: 'done' });
      expect(consultation?.routing).toMatchObject({
        excluded: ['lab-interpretation'],
      });
      const [artifact] = await artifactsOf(taskId);
      expect(artifact?.consultation_id).toBe(consultation?.id);
      const content = artifact!.content as { professional: string; clientFacing: string };
      expect(content.professional).toContain('## 专家意见汇总');
      expect(content.professional).toContain('## 专家分歧');
      expect(content.clientFacing).not.toContain('专家');
      const skills = (await agent.get('/api/skills').expect(200)).body.skills as {
        id: string;
        experts: string;
      }[];
      expect(skills.find((s) => s.id === 'report-interpretation')?.experts).toBe('auto');

      provider.calls.length = 0;
      await agent
        .post(`/api/artifacts/${artifact!.id}/return`)
        .send({ reason: '请写得更具体一些' })
        .expect(200);
      expect(provider.routes()).toEqual(['report_interpretation']);
      const versions = await artifactsOf(taskId);
      expect(versions).toHaveLength(2);
      expect(versions[1]?.consultation_id).toBe(consultation?.id);
      expect(await consultationsOf(taskId)).toHaveLength(1);
    });

    it('想一想：确认计划后按提出计划时的选择请专家，触发方式记为计划', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      const res = await send(agent, taskId, {
        mode: 'plan',
        content: '帮我解读一下这份报告',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
        expertRefs: ['cardiovascular'],
      }).expect(200);
      const plan = parseSse(res.text).find((e) => e.type === 'plan');
      expect(plan).toBeDefined();
      expect(provider.calls).toEqual([]);
      await agent
        .post(`/api/tasks/${taskId}/plans/${(plan as { plan: { id: string } }).plan.id}/confirm`)
        .expect(200);
      const experts = provider.routes().filter((r) => r.startsWith('expert:'));
      expect(experts).toContain('expert:cardiovascular');
      expect(experts.length).toBeLessThanOrEqual(3);
      const [consultation] = await consultationsOf(taskId);
      expect(consultation?.trigger).toBe('plan');
    });
  });

  describe('专家标签和反馈（规格 2.7、2.9）', () => {
    it('健管师本人能看到任务里的专家调用和详情，能给反馈并修改', async () => {
      const agent = await as(f.users.managerA1.email);
      const { taskId, consultation } = await askBound(agent);
      const list = (await agent.get(`/api/tasks/${taskId}/expert-consultations`).expect(200)).body
        .consultations;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: consultation.id, trigger: 'expert_center' });
      const detail = (await agent.get(`/api/expert-consultations/${consultation.id}`).expect(200))
        .body.consultation;
      const call = detail.calls[0];
      expect(call).toMatchObject({
        expertId: 'endocrine-metabolism',
        status: 'done',
        feedback: null,
      });

      await agent
        .put(`/api/expert-calls/${call.id}/feedback`)
        .send({ rating: 'useful' })
        .expect(204);
      await agent
        .put(`/api/expert-calls/${call.id}/feedback`)
        .send({ rating: 'not_useful', reason: 'too_general' })
        .expect(204);
      await agent
        .put(`/api/expert-calls/${call.id}/feedback`)
        .send({ rating: 'useful', reason: 'other' })
        .expect(400);
      await agent
        .put(`/api/expert-calls/${call.id}/feedback`)
        .send({ rating: 'useful', comment: '自由文字' })
        .expect(400);
      const again = (await agent.get(`/api/expert-consultations/${consultation.id}`).expect(200))
        .body.consultation;
      expect(again.calls[0].feedback).toEqual({ rating: 'not_useful', reason: 'too_general' });
      expect(
        (await agent.get('/api/experts/endocrine-metabolism').expect(200)).body.expert.myUsageCount,
      ).toBe(1);
    });

    it('跨租户访问被拒绝：同机构、别的机构、别的协会的健管师和各级管理员看不到专家调用，也不能反馈', async () => {
      const a1 = await as(f.users.managerA1.email);
      const { taskId, consultation } = await askBound(a1);
      const callId = (
        await owner
          .selectFrom('expert_calls')
          .select('id')
          .where('consultation_id', '=', consultation.id)
          .executeTakeFirstOrThrow()
      ).id;
      for (const u of [
        f.users.managerA2,
        f.users.managerA3,
        f.users.managerB1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const other = await as(u.email);
        await other.get(`/api/tasks/${taskId}/expert-consultations`).expect(404);
        await other.get(`/api/expert-consultations/${consultation.id}`).expect(404);
        await other
          .put(`/api/expert-calls/${callId}/feedback`)
          .send({ rating: 'useful' })
          .expect(404);
      }
      expect(await owner.selectFrom('expert_feedback').selectAll().execute()).toEqual([]);
      // 格式不对的 id 也按不存在处理
      await a1.get('/api/expert-consultations/not-a-uuid').expect(404);
      await a1.put('/api/expert-calls/not-a-uuid/feedback').send({ rating: 'useful' }).expect(404);
    });

    it('客户转出后任务只读：意见仍可查看，不能再反馈（409）', async () => {
      const a1 = await as(f.users.managerA1.email);
      const { consultation } = await askBound(a1);
      const call = await owner
        .selectFrom('expert_calls')
        .select('id')
        .where('consultation_id', '=', consultation.id)
        .executeTakeFirstOrThrow();
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      await a1.get(`/api/expert-consultations/${consultation.id}`).expect(200);
      await a1.put(`/api/expert-calls/${call.id}/feedback`).send({ rating: 'useful' }).expect(409);
      const a2 = await as(f.users.managerA2.email);
      await a2.get(`/api/expert-consultations/${consultation.id}`).expect(404);
    });
  });
  describe('合规审查和租户隔离审查的补充', () => {
    const interpret = (agent: Agent, taskId: string, extra: Record<string, unknown> = {}) =>
      send(agent, taskId, {
        mode: 'craft',
        content: '帮我解读一下这份报告',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
        ...extra,
      }).expect(200);
    const answerOf = async (taskId: string) =>
      (
        await owner
          .selectFrom('task_messages')
          .select('content')
          .where('task_id', '=', taskId)
          .where('role', '=', 'assistant')
          .executeTakeFirstOrThrow()
      ).content as string;
    const scopeOf = (manager: { id: string }) => ({
      operator_id: f.operatorA,
      org_id: f.orgA,
      manager_id: manager.id,
    });

    /** 用所有者身份给某位健管师补 n 次今天的专家调用（每次调用一位专家） */
    async function fillCalls(manager: { id: string }, n: number, clientId: string | null = null) {
      const scope = scopeOf(manager);
      const task = await owner
        .insertInto('tasks')
        .values({ ...scope, client_id: clientId, title: '合成任务' })
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
      const consultations: string[] = [];
      for (let i = 0; i < n; i++) {
        const c = await owner
          .insertInto('expert_consultations')
          .values({
            ...scope,
            task_id: task.id,
            message_id: message.id,
            client_id: clientId,
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
        consultations.push(c.id as string);
      }
      return { taskId: task.id as string, consultations };
    }

    it('专家都拒答时，回答仍以心理危机提示开头，再给固定提示', async () => {
      provider.scripts['expert:endocrine-metabolism'] = { refused: true };
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { expertId: 'endocrine-metabolism' });
      await send(agent, taskId, {
        mode: 'ask',
        content: '客户说最近不想活了，血糖怎么办？',
      }).expect(200);
      const answer = await answerOf(taskId);
      expect(answer.startsWith('**心理危机提示**')).toBe(true);
      expect(answer.endsWith('专家暂时无法回复，请稍后再试。')).toBe(true);
    });

    it('专家标出的危机和急症信号进入解读：专业版最前面有提示，产物带急症标记', async () => {
      provider.scripts['expert:endocrine-metabolism'] = {
        json: { ...opinion(), crisisSignal: true },
      };
      provider.scripts['expert:nutrition'] = { json: { ...opinion(), emergencySignal: true } };
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      await interpret(agent, taskId, { excludedExperts: ['lab-interpretation'] });
      const [artifact] = await artifactsOf(taskId);
      const content = artifact!.content as { professional: string; clientFacing: string };
      expect(content.professional.startsWith('**疑似急症提示**')).toBe(true);
      expect(content.professional).toContain('## 心理危机提示');
      expect(artifact?.emergency_signal).toBe(true);
      const detail = (await agent.get(`/api/artifacts/${artifact!.id}`).expect(200)).body;
      expect(detail.artifact.emergencySignal).toBe(true);
      // 有信号的意见不提供可改写进通俗版的建议
      const skillCall = provider.calls.find((c) => c.route === 'report_interpretation')!;
      const prompt = JSON.stringify(skillCall.messages);
      expect(prompt).toContain('第二部分');
      expect(prompt.split('第二部分')[1]).toContain('（没有）');
    });

    it('通俗版出现“专家”或专家名称时带纠正说明重新生成，第二次仍有就不保存草稿', async () => {
      const leaky = {
        json: { ...interpretationJson, clientFacing: '营养专家建议您晚餐少吃甜食。' },
      };
      provider.scripts['report_interpretation'] = [leaky, { json: interpretationJson }];
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, { clientId: f.clients.a1[0] });
      await interpret(agent, taskId);
      const skillCalls = provider.calls.filter((c) => c.route === 'report_interpretation');
      expect(skillCalls).toHaveLength(2);
      expect(JSON.stringify(skillCalls[1]?.messages)).toContain('通俗版里出现了“专家”');
      expect(await artifactsOf(taskId)).toHaveLength(1);

      provider.reset();
      provider.scripts['report_interpretation'] = leaky;
      const second = await newTask(agent, { clientId: f.clients.a1[0] });
      const res = await interpret(agent, second);
      expect(res.text).toContain('wording_check_failed');
      expect(await artifactsOf(second)).toEqual([]);
    });

    it('别的健管师的专家调用不影响本人的每日次数和使用次数', async () => {
      await fillCalls(f.users.managerA2, 200);
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      await send(agent, taskId, {
        mode: 'ask',
        content: '饮食问题',
        expertRefs: ['nutrition'],
      }).expect(200);
      expect((await agent.get('/api/experts/nutrition').expect(200)).body.expert.myUsageCount).toBe(
        1,
      );
    });

    it('跨租户访问被拒绝：停止别人的任务 404，别人进行中的专家调用不受影响', async () => {
      const { taskId, consultations } = await fillCalls(f.users.managerA1, 1);
      for (const u of [f.users.managerA2, f.users.managerB1]) {
        const other = await as(u.email);
        await other.post(`/api/tasks/${taskId}/stop`).expect(404);
      }
      const row = await owner
        .selectFrom('expert_consultations')
        .select('status')
        .where('id', '=', consultations[0]!)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('running');
      const calls = await owner
        .selectFrom('expert_calls')
        .select('status')
        .where('consultation_id', '=', consultations[0]!)
        .execute();
      expect(calls).toEqual([{ status: 'running' }]);
    });

    it('跨租户访问被拒绝：@专家 时 @ 别人的客户 404，不调用任何模型', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent);
      for (const clientId of [f.clients.a2, f.clients.b1, f.clients.a3]) {
        await send(agent, taskId, {
          mode: 'ask',
          content: '这位客户饮食怎么调整？',
          clientRefs: [clientId],
          expertRefs: ['nutrition'],
        }).expect(404);
      }
      expect(provider.calls).toEqual([]);
      expect(await consultationsOf(taskId)).toEqual([]);
    });
  });
});
