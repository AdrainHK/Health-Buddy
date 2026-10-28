import { followUpListResponseSchema, taskDetailResponseSchema } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { NO_TWIN_EXPERT } from '../src/workbench/generation.service.js';
import { TEST_APP_URL } from './env.js';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 手动调整理由、跟进备注里虚构的电话（全部是合成数据），检查提示词里没有 */
const PHONE_IN_REASON = '13800001111';
const PHONE_IN_NOTE = '139 0000 2222';

/** 模型写的 /孪生小结（合成数据）：只引用输入里的数值 */
const twinSummaryJson = (overview = '代谢方面需要留意，心血管平稳。') => ({
  professional: {
    overview,
    domains: [
      { domain: 'metabolic', explanation: '健管师已手动调整，理由见上。' },
      { domain: 'cardiovascular', explanation: '按规则计算为平稳。' },
    ],
    changes: [],
    trends: [
      {
        metric: 'sbp',
        source: 'monitoring',
        comment: '如果按过去的走势，可能缓慢上升；预测有不确定性，没有考虑用药和生活方式变化。',
      },
    ],
    followUps: ['代谢状态变差，建议了解近期饮食。'],
    suggestions: ['建议了解近期家庭血压的测量方法和时间。'],
    referralAdvice: null,
    dataGaps: [],
  },
  crisisSignal: false,
});

/**
 * M4 第 4 步：/孪生小结、@孪生项、“请专家看看”（规格 2.6 之二、2.7–2.9、7.2、7.3）。
 * 每个扩展的接口都有“跨租户访问被拒绝”的测试：不通过一律 404，并且不调用任何模型。
 * 孪生数据以所有者身份直接写入（全部是合成数据）。
 */
describe('孪生 AI：孪生小结、@孪生项、请专家看看', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  const prodProvider = new ExpertProvider();
  let preview: INestApplication;
  let prod: INestApplication;
  let appDb: Kysely<Database>;
  let f: Fixtures;
  let followUpA1: string;
  let followUpA1Other: string;
  let followUpA2: string;

  const as = (email: string, target = preview) => loginAs(target, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const artifactsOf = (taskId: string) =>
    owner.selectFrom('artifacts').selectAll().where('task_id', '=', taskId).execute();
  const consultationsOf = (taskId: string) =>
    owner.selectFrom('expert_consultations').selectAll().where('task_id', '=', taskId).execute();
  const statusRows = (clientId: string) =>
    owner
      .selectFrom('twin_status_history')
      .select(['id', 'domain', 'level', 'origin'])
      .where('client_id', '=', clientId)
      .orderBy('id')
      .execute();
  const stepKinds = (text: string) =>
    parseSse(text).flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
  const textOf = (text: string) =>
    parseSse(text)
      .flatMap((e) => (e.type === 'text' ? [e.delta] : []))
      .join('');

  async function followUp(clientId: string, note: string | null = null, domain = 'metabolic') {
    const row = await owner
      .insertInto('follow_up_items')
      .values({
        client_id: clientId,
        kind: 'status_worsened',
        severity: 3,
        domain: domain as 'metabolic',
        basis: JSON.stringify({ domain, from: 'green', to: 'yellow', items: [] }),
        source_ref: JSON.stringify({}),
        dedupe_key: `status_worsened:${domain}`,
        note,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  }

  /** A1 的第一位客户：系统算黄、健管师手动调成绿（理由带姓名电话）；心血管绿；收缩压有预测 */
  async function seedTwin(clientId: string, managerId: string) {
    const computed = (domain: string, level: string) => ({
      client_id: clientId,
      domain: domain as 'metabolic',
      level: level as 'yellow',
      origin: 'computed' as const,
      basis: JSON.stringify([]),
      rules_version: 1,
      trigger: 'backfill' as const,
    });
    await owner
      .insertInto('twin_status_history')
      .values([computed('metabolic', 'yellow'), computed('cardiovascular', 'green')])
      .execute();
    await owner
      .insertInto('twin_status_history')
      .values({
        client_id: clientId,
        domain: 'metabolic',
        level: 'green',
        origin: 'manual',
        basis: JSON.stringify([]),
        rules_version: 1,
        trigger: 'manual',
        reason: `测试客户 A1-1 说体检前吃了火锅，电话 ${PHONE_IN_REASON} 已复测正常`,
        manual_expires: 'never',
        set_by: managerId,
      })
      .execute();
    await owner
      .insertInto('twin_forecasts')
      .values({
        client_id: clientId,
        metric: 'sbp',
        source: 'report',
        method_version: 'ols-linear-v1',
        horizon_months: 3,
        points: JSON.stringify([
          {
            monthsAhead: 3,
            date: '2026-04-01',
            mid: 131.5,
            low: 122.3,
            high: 140.7,
            clipped: false,
          },
        ]),
        basis: JSON.stringify({
          kind: 'report_values',
          from: '2025-01-01',
          to: '2026-01-01',
          anchor: '2026-01-01',
        }),
        fit: JSON.stringify({
          origin: '2025-01-01',
          originAt: '2025-01-01T00:00:00.000Z',
          n: 3,
          intercept: 120,
          slopePerDay: 0.03,
          meanX: 180,
          sxx: 66000,
          residualSd: 4,
        }),
        n_points: 3,
        span_days: 365,
        uncertainty: 'normal',
        status: 'ok',
      })
      .execute();
  }

  beforeAll(async () => {
    preview = await createTestApp({ expertsPreview: true }, { llmProviders: { openai: provider } });
    prod = await createTestApp({}, { llmProviders: { openai: prodProvider } });
    appDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    provider.reset();
    prodProvider.reset();
    await seedTwin(f.clients.a1[0], f.users.managerA1.id);
    followUpA1 = await followUp(f.clients.a1[0], `测试客户 A1-1 换了工作，手机 ${PHONE_IN_NOTE}`);
    followUpA1Other = await followUp(f.clients.a1[1]);
    followUpA2 = await followUp(f.clients.a2);
  });

  afterAll(async () => {
    await preview.close();
    await prod.close();
    await appDb.destroy();
    await owner.destroy();
  });

  // ---------- POST /api/tasks/:id/messages：跨租户访问被拒绝 ----------

  describe('POST /api/tasks/:id/messages 带孪生项：跨租户访问被拒绝（404，不调用模型）', () => {
    it('任务没有关联客户、引用别人的客户、任务客户和孪生项客户不一致 → 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      const twinRefs = [{ kind: 'domain', code: 'metabolic' }];
      // 任务没有关联客户
      const empty = await newTask(a1);
      await send(a1, empty, { mode: 'ask', content: '看看代谢', twinRefs }).expect(404);
      // 引用同协会其他健管师的客户、协会 B 的客户
      for (const other of [f.clients.a2, f.clients.b1]) {
        const t = await newTask(a1);
        await send(a1, t, {
          mode: 'ask',
          content: '看看代谢',
          clientRefs: [other],
          twinRefs,
        }).expect(404);
      }
      // 任务关联 A1-1，孪生项按 A1-2 引用
      const bound = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, bound, {
        mode: 'ask',
        content: '看看代谢',
        clientRefs: [f.clients.a1[1]],
        twinRefs,
      }).expect(404);
      expect(provider.calls).toHaveLength(0);
    });

    it('别人的任务、目录外的编码、客户没有预测的指标 → 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      for (const u of [f.users.managerA2, f.users.managerB1]) {
        const other = await as(u.email);
        await send(other, task, {
          mode: 'ask',
          content: '看看',
          twinRefs: [{ kind: 'domain', code: 'metabolic' }],
        }).expect(404);
      }
      for (const ref of [
        { kind: 'domain', code: 'kidney' },
        { kind: 'metric', code: 'not_a_metric' },
        // 目录里的预测指标，但这位客户没有它的预测
        { kind: 'metric', code: 'uric_acid' },
      ]) {
        await send(a1, task, { mode: 'ask', content: '看看', twinRefs: [ref] }).expect(404);
      }
      expect(provider.calls).toHaveLength(0);
    });

    it('“请专家看看”：别的健管师的跟进项、同一健管师别的客户的跟进项 → 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      for (const id of [followUpA2, followUpA1Other]) {
        await send(a1, task, {
          mode: 'ask',
          content: '',
          twinRefs: [{ kind: 'domain', code: 'metabolic' }],
          twinConsult: true,
          followUpItemId: id,
        }).expect(404);
      }
      expect(provider.calls).toHaveLength(0);
      expect(await consultationsOf(task)).toHaveLength(0);
    });

    it('专家预览关闭时没有“请专家看看”（404）；孪生项只能在问一问里用（400）', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'metabolic' }],
        twinConsult: true,
      }).expect(404);
      await send(a1, task, {
        mode: 'plan',
        content: '看看',
        twinRefs: [{ kind: 'domain', code: 'metabolic' }],
      }).expect(400);
      expect(prodProvider.calls).toHaveLength(0);
    });
  });

  // ---------- 问一问 @孪生项 ----------

  it('问一问 @孪生项：读取数字孪生，回答不生成产物；提示词里没有姓名和电话', async () => {
    const a1 = await as(f.users.managerA1.email, prod);
    const task = await newTask(a1);
    prodProvider.scripts.chat = { text: '按规则，代谢为绿色（健管师手动调整）。' };
    const res = await send(a1, task, {
      mode: 'ask',
      content: '测试客户 A1-1 的收缩压趋势靠谱吗？',
      clientRefs: [f.clients.a1[0]],
      twinRefs: [
        { kind: 'metric', code: 'sbp' },
        { kind: 'domain', code: 'metabolic' },
      ],
    }).expect(200);
    expect(stepKinds(res.text)).toEqual([
      'read_client',
      'detect_critical',
      'read_twin',
      'read_care_plan',
      'answer',
    ]);
    expect(await artifactsOf(task)).toHaveLength(0);
    const call = prodProvider.calls.at(-1)!;
    expect(call.route).toBe('chat');
    expect(call.system).toContain('孪生资料的使用规则');
    const prompt = JSON.stringify(call.messages);
    expect(prompt).toContain('这次引用的孪生项：孪生 · 收缩压趋势、孪生 · 代谢');
    expect(prompt).toContain('131.5');
    for (const leaked of ['测试客户', PHONE_IN_REASON, PHONE_IN_NOTE, '13900002222']) {
      expect(prompt).not.toContain(leaked);
    }
    // 消息记下孪生项（只有编码），任务详情能读回
    const detail = taskDetailResponseSchema.parse(
      (await a1.get(`/api/tasks/${task}`).expect(200)).body,
    );
    expect(detail.messages.find((m) => m.role === 'manager')?.twinRefs).toEqual([
      { kind: 'metric', code: 'sbp' },
      { kind: 'domain', code: 'metabolic' },
    ]);
  });

  // ---------- /孪生小结 ----------

  describe('/孪生小结', () => {
    it('只有专业版草稿；颜色和预测数字照抄孪生；复制、导出 409；确认不改变状态', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.skill = { json: twinSummaryJson() };
      const res = await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'twin-summary',
      }).expect(200);
      expect(stepKinds(res.text)).toEqual([
        'read_client',
        'read_twin',
        'compute_forecast',
        'detect_critical',
        'run_skill',
      ]);
      const [artifact] = await artifactsOf(task);
      expect(artifact).toMatchObject({ kind: 'twin_summary', skill_id: 'twin-summary' });
      const content = artifact!.content as { professional: string; clientFacing: string };
      expect(content.clientFacing).toBe('');
      expect(content.professional).toContain('**代谢**：绿（平稳） · 健管师手动调整');
      expect(content.professional).toContain('**心血管**：绿（平稳）');
      expect(content.professional).toContain('3 个月后中间值约 131.5 mmHg，80% 区间 122.3–140.7');
      expect(content.professional).toContain('确认本小结不会改变任何状态');
      // 模型输入去标识：手动调整理由、跟进备注里的姓名和电话
      const prompt = JSON.stringify(prodProvider.calls.at(-1));
      for (const leaked of ['测试客户', PHONE_IN_REASON, PHONE_IN_NOTE]) {
        expect(prompt).not.toContain(leaked);
      }

      // 没有通俗版：不能复制、导出给客户
      const before = await statusRows(f.clients.a1[0]);
      const hash = (await a1.get(`/api/artifacts/${artifact!.id}`).expect(200)).body.artifact
        .contentHash as string;
      await a1
        .post(`/api/artifacts/${artifact!.id}/approve`)
        .send({ version: 1, contentHash: hash })
        .expect(200);
      await a1.post(`/api/artifacts/${artifact!.id}/copy`).expect(409);
      await a1.post(`/api/artifacts/${artifact!.id}/export`).send({ format: 'png' }).expect(409);
      // 确认小结不改变任何状态
      expect(await statusRows(f.clients.a1[0])).toEqual(before);
    });

    it('说明文字里有输入以外的数字：带纠正说明重试一次，仍有就不保存草稿', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.skill = { json: twinSummaryJson('收缩压 6 个月后约 152.8 mmHg。') };
      const res = await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'twin-summary',
      }).expect(200);
      expect(parseSse(res.text)).toContainEqual({ type: 'error', kind: 'wording_check_failed' });
      expect(await artifactsOf(task)).toHaveLength(0);
      const skillCalls = prodProvider.calls.filter((c) => c.route === 'skill');
      expect(skillCalls).toHaveLength(2);
      expect(JSON.stringify(skillCalls[1]!.messages)).toContain('资料里没有的数值');
    });

    it('说状态结论和疾病风险：同样不保存', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.skill = {
        json: twinSummaryJson('代谢应改为红色，按走势他会得糖尿病。'),
      };
      await send(a1, task, { mode: 'craft', content: '', skillId: 'twin-summary' }).expect(200);
      expect(await artifactsOf(task)).toHaveLength(0);
    });

    it('客户还没有孪生数据 → 409 no_twin_data，不调用模型', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[1] });
      const res = await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'twin-summary',
      }).expect(409);
      expect(res.body.reasons).toEqual(['no_twin_data']);
      expect(prodProvider.calls).toHaveLength(0);
    });

    it('别人的客户 → 404，不调用模型', async () => {
      const b1 = await as(f.users.managerB1.email, prod);
      const task = await newTask(b1);
      await send(b1, task, {
        mode: 'craft',
        content: '',
        skillId: 'twin-summary',
        clientRefs: [f.clients.a1[0]],
      }).expect(404);
      expect(prodProvider.calls).toHaveLength(0);
    });

    it('想一想“孪生复盘”：先出计划（读档案 → 读数字孪生 → /孪生小结），确认后起草', async () => {
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const res = await send(a1, task, {
        mode: 'plan',
        content: '',
        skillId: 'twin-review',
      }).expect(200);
      const plan = parseSse(res.text).find((e) => e.type === 'plan');
      expect(plan?.type === 'plan' && plan.plan.steps).toEqual([
        { kind: 'read_client' },
        { kind: 'read_twin' },
        { kind: 'run_skill', skillId: 'twin-summary' },
      ]);
      expect(prodProvider.calls).toHaveLength(0);
      prodProvider.scripts.skill = { json: twinSummaryJson() };
      const planId = plan?.type === 'plan' ? plan.plan.id : '';
      await a1.post(`/api/tasks/${task}/plans/${planId}/confirm`).expect(200);
      expect((await artifactsOf(task)).map((a) => a.kind)).toEqual(['twin_summary']);
    });
  });

  // ---------- “请专家看看” ----------

  describe('请专家看看', () => {
    it('按孪生项选专家，触发方式记为 twin；跟进项显示已请专家，状态不变；输入去标识', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const res = await send(a1, task, {
        mode: 'ask',
        content: '',
        clientRefs: [f.clients.a1[0]],
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        twinConsult: true,
        followUpItemId: followUpA1,
      }).expect(200);
      expect(stepKinds(res.text).slice(0, 4)).toEqual([
        'read_client',
        'detect_critical',
        'read_twin',
        'route_experts',
      ]);
      // 没有补充问题：只按规则选，不调用路由模型
      expect(provider.routes()).not.toContain('expert_routing');
      expect(provider.routes()).toContain('expert:cardiovascular');
      const [c] = await consultationsOf(task);
      expect(c).toMatchObject({
        trigger: 'twin',
        follow_up_item_id: followUpA1,
        twin_refs: [{ kind: 'domain', code: 'cardiovascular' }],
      });
      for (const call of provider.calls) {
        const prompt = JSON.stringify(call);
        for (const leaked of ['测试客户', PHONE_IN_REASON, PHONE_IN_NOTE]) {
          expect(prompt).not.toContain(leaked);
        }
      }
      const expertPrompt = JSON.stringify(
        provider.calls.find((x) => x.expertId === 'cardiovascular'),
      );
      expect(expertPrompt).toContain('数字孪生');
      expect(expertPrompt).toContain('这次引用的孪生项：孪生 · 心血管');
      // 跟进项：已请专家（时间），仍未处理
      const list = followUpListResponseSchema.parse(
        (await a1.get(`/api/follow-ups?clientId=${f.clients.a1[0]}`).expect(200)).body,
      );
      const item = list.items.find((i) => i.id === followUpA1)!;
      expect(item.status).toBe('open');
      expect(item.consultedAt).not.toBeNull();
      // 回答带 M3 的免责提示
      expect(textOf(res.text)).toContain('非医疗诊断');
    });

    it('补充了问题时才用模型补充路由', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, task, {
        mode: 'ask',
        content: '最近作息不规律，也请看看',
        twinRefs: [{ kind: 'metric', code: 'sbp' }],
        twinConsult: true,
      }).expect(200);
      expect(provider.routes()).toContain('expert_routing');
    });

    it('没有负责这个方面的专家（睡眠）：固定回答，不调用专家，跟进项不记已请专家', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const sleepItem = await followUp(f.clients.a1[0], null, 'sleep');
      const res = await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'sleep' }],
        twinConsult: true,
        followUpItemId: sleepItem,
      }).expect(200);
      expect(textOf(res.text)).toContain(NO_TWIN_EXPERT);
      expect(provider.calls.filter((c) => c.expertId)).toHaveLength(0);
      const events = await owner
        .selectFrom('follow_up_events')
        .select('action')
        .where('item_id', '=', sleepItem)
        .where('action', '=', 'consulted')
        .execute();
      expect(events).toHaveLength(0);
    });

    it('疑似急症关键词：和 M3 一样记进调用并置顶提示；专家都没回复时回答以提示开头', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const res = await send(a1, task, {
        mode: 'ask',
        content: '客户昨天晕厥了一次，请看看',
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        twinConsult: true,
      }).expect(200);
      expect(parseSse(res.text)).toContainEqual(
        expect.objectContaining({ type: 'consultation', emergencySignal: true }),
      );
      expect((await consultationsOf(task))[0]).toMatchObject({ emergency_signal: true });

      for (const id of ['cardiovascular', 'lab-interpretation']) {
        provider.scripts[`expert:${id}`] = { fail: true };
      }
      const failed = await send(a1, task, {
        mode: 'ask',
        content: '客户昨天晕厥了一次，请再看看',
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        twinConsult: true,
      }).expect(200);
      expect(textOf(failed.text).startsWith('**疑似急症提示**')).toBe(true);
    });
  });

  // ---------- 数据库层：跟进项必须属于调用的客户和健管师（迁移 0018） ----------

  describe('expert_consultations.follow_up_item_id 的约束', () => {
    const managerA1 = (): TenantContext => ({
      userId: f.users.managerA1.id,
      role: 'manager',
      operatorId: f.operatorA,
      orgId: f.orgA,
    });

    async function insertConsultation(followUpItemId: string, trigger: 'twin' | 'mention') {
      return withTenant(appDb, managerA1(), async (trx) => {
        const scope = {
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
        };
        const task = await trx
          .insertInto('tasks')
          .values({ ...scope, client_id: f.clients.a1[0], title: '测试任务' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const message = await trx
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
        await trx
          .insertInto('expert_consultations')
          .values({
            ...scope,
            task_id: task.id,
            message_id: message.id,
            client_id: f.clients.a1[0],
            trigger,
            routing: JSON.stringify({ selected: [], excluded: [], overCap: [], ruleOnly: false }),
            status: 'running',
            follow_up_item_id: followUpItemId,
          })
          .execute();
      });
    }

    it('本人这位客户的跟进项可以；别的客户、别的健管师的跟进项、非 twin 触发都被拒绝', async () => {
      await insertConsultation(followUpA1, 'twin');
      // 触发器：别的客户、别的健管师（行级安全看不到）的跟进项 → check_violation
      await expect(insertConsultation(followUpA1Other, 'twin')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('follow-up item must belong'),
      });
      await expect(insertConsultation(followUpA2, 'twin')).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('follow-up item must belong'),
      });
      // 检查约束：跟进项只能随 twin 触发
      await expect(insertConsultation(followUpA1, 'mention')).rejects.toMatchObject({
        code: '23514',
        constraint: 'expert_consultations_follow_up',
      });
    });

    it('跟进项随客户删除：调用记录的 follow_up_item_id 由系统级联置空', async () => {
      await insertConsultation(followUpA1, 'twin');
      await owner.deleteFrom('follow_up_items').where('client_id', '=', f.clients.a1[0]).execute();
      const rows = await owner
        .selectFrom('expert_consultations')
        .select('follow_up_item_id')
        .where('trigger', '=', 'twin')
        .execute();
      expect(rows).toEqual([{ follow_up_item_id: null }]);
    });

    it('应用角色不能直接改调用记录上的跟进项', async () => {
      await insertConsultation(followUpA1, 'twin');
      await expect(
        withTenant(appDb, managerA1(), (trx) =>
          trx
            .updateTable('expert_consultations')
            .set({ follow_up_item_id: null } as never)
            .execute(),
        ),
      ).rejects.toMatchObject({
        // 列级授权里没有这一列：权限不足（触发器之前就被拒绝）
        code: '42501',
        message: expect.stringContaining('permission denied'),
      });
    });
  });

  // ---------- 合规、租户审核补充（PR #46） ----------

  describe('合规、租户审核补充（PR #46）', () => {
    const messagesOf = (taskId: string) =>
      owner.selectFrom('task_messages').select('id').where('task_id', '=', taskId).execute();
    const taskClient = async (taskId: string) =>
      (
        await owner
          .selectFrom('tasks')
          .select('client_id')
          .where('id', '=', taskId)
          .executeTakeFirstOrThrow()
      ).client_id;
    const consultedEvents = () =>
      owner.selectFrom('follow_up_events').select('id').where('action', '=', 'consulted').execute();
    /** 用所有者身份给 A1 补 n 次今天的专家调用 */
    async function fillCalls(n: number) {
      const scope = {
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
      };
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

    it('B1 问一问 @孪生项：跟进备注原文里的危机字样也置顶提示（提示词里仍去标识）', async () => {
      await followUp(f.clients.a1[0], '测试客户 A1-1 说最近不想活了', 'cardiovascular');
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.chat = { text: '按规则，心血管为绿色。' };
      const res = await send(a1, task, {
        mode: 'ask',
        content: '心血管怎么样？',
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
      }).expect(200);
      expect(textOf(res.text).startsWith('**心理危机提示**')).toBe(true);
      expect(JSON.stringify(prodProvider.calls.at(-1)!.messages)).not.toContain('测试客户');
    });

    it('B1 /孪生小结：手动调整理由、跟进备注里的急症字样记进草稿的信号', async () => {
      await followUp(f.clients.a1[0], '昨晚胸痛，出冷汗', 'cardiovascular');
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.skill = { json: twinSummaryJson() };
      await send(a1, task, { mode: 'craft', content: '', skillId: 'twin-summary' }).expect(200);
      const [artifact] = await artifactsOf(task);
      expect(artifact).toMatchObject({ emergency_signal: true });
      expect((artifact!.content as { professional: string }).professional).toContain(
        '**疑似急症提示**',
      );
    });

    it('B1 请专家看看：跟进备注里的危机字样记进调用', async () => {
      const item = await followUp(f.clients.a1[0], '客户说活着没意思', 'cardiovascular');
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        twinConsult: true,
        followUpItemId: item,
      }).expect(200);
      expect((await consultationsOf(task))[0]).toMatchObject({ crisis_signal: true });
    });

    it('有危急指标时“请专家看看”的回答（含没有对应专家的固定回答）开头带危急指标提醒', async () => {
      await owner
        .insertInto('monitoring_readings')
        .values({
          client_id: f.clients.a1[0],
          metric: 'sbp',
          value: 186,
          unit: 'mmHg',
          measured_at: new Date(),
          source: 'synthetic',
        })
        .execute();
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const sleep = await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'sleep' }],
        twinConsult: true,
      }).expect(200);
      expect(textOf(sleep.text).startsWith('**危急指标提醒**')).toBe(true);
      expect(textOf(sleep.text)).toContain(NO_TWIN_EXPERT);
      const cardio = await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
        twinConsult: true,
      }).expect(200);
      expect(textOf(cardio.text).startsWith('**危急指标提醒**')).toBe(true);
    });

    it('预测越过危急阈值：后端算好越线写进提示词，模型照抄', async () => {
      await owner
        .updateTable('twin_forecasts')
        .set({
          points: JSON.stringify([
            {
              monthsAhead: 3,
              date: '2026-04-01',
              mid: 176.2,
              low: 165.1,
              high: 187.3,
              clipped: false,
            },
          ]),
        })
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      const a1 = await as(f.users.managerA1.email, prod);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      prodProvider.scripts.chat = { text: '按走势，收缩压可能继续上升。' };
      await send(a1, task, {
        mode: 'ask',
        content: '收缩压趋势怎么样？',
        twinRefs: [{ kind: 'metric', code: 'sbp' }],
      }).expect(200);
      const prompt = JSON.stringify(prodProvider.calls.at(-1)!.messages);
      expect(prompt).toContain('3 个月后的区间上端达到危急阈值 ≥ 180（该阈值级别：需尽快就医）');
    });

    it('T7 问一问同时 @专家 和 @孪生项：专家拿到孪生资料，调用记下孪生项', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, task, {
        mode: 'ask',
        content: '心血管怎么看？',
        expertRefs: ['cardiovascular'],
        twinRefs: [{ kind: 'domain', code: 'cardiovascular' }],
      }).expect(200);
      const [c] = await consultationsOf(task);
      expect(c).toMatchObject({
        trigger: 'mention',
        twin_refs: [{ kind: 'domain', code: 'cardiovascular' }],
        follow_up_item_id: null,
      });
      const prompt = JSON.stringify(provider.calls.find((x) => x.expertId === 'cardiovascular'));
      expect(prompt).toContain('这次引用的孪生项：孪生 · 心血管');
      expect(prompt).not.toContain(PHONE_IN_REASON);
    });

    it('T4 404 的请求不写消息、不绑定客户', async () => {
      const a1 = await as(f.users.managerA1.email);
      const empty = await newTask(a1);
      for (const other of [f.clients.a2, f.clients.b1]) {
        await send(a1, empty, {
          mode: 'ask',
          content: '',
          clientRefs: [other],
          twinRefs: [{ kind: 'domain', code: 'metabolic' }],
          twinConsult: true,
        }).expect(404);
      }
      // 自己的客户、别人的跟进项：同样不写任何东西、不绑定客户
      await send(a1, empty, {
        mode: 'ask',
        content: '',
        clientRefs: [f.clients.a1[0]],
        twinRefs: [{ kind: 'domain', code: 'metabolic' }],
        twinConsult: true,
        followUpItemId: followUpA2,
      }).expect(404);
      expect(await messagesOf(empty)).toHaveLength(0);
      expect(await taskClient(empty)).toBeNull();
      expect(await consultationsOf(empty)).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
    });

    it('T4 客户转出后：@孪生项、请专家看看都被拒绝，不调用模型，跟进项不记已请专家', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      const before = (await messagesOf(task)).length;
      for (const body of [
        { mode: 'ask', content: '看看', twinRefs: [{ kind: 'domain', code: 'metabolic' }] },
        {
          mode: 'ask',
          content: '',
          twinRefs: [{ kind: 'domain', code: 'metabolic' }],
          twinConsult: true,
          followUpItemId: followUpA1,
        },
      ]) {
        const res = await send(a1, task, body);
        expect([404, 409]).toContain(res.status);
      }
      expect(provider.calls).toHaveLength(0);
      expect(await messagesOf(task)).toHaveLength(before);
      expect(await consultedEvents()).toHaveLength(0);
    });

    it('T5 当天次数用完时：别人的跟进项仍返回 404（不是 429）；自己的才是 429', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await fillCalls(200);
      const base = {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'domain', code: 'metabolic' }],
        twinConsult: true,
      };
      await send(a1, task, { ...base, followUpItemId: followUpA2 }).expect(404);
      await send(a1, task, { ...base, twinRefs: [{ kind: 'metric', code: 'uric_acid' }] }).expect(
        404,
      );
      await send(a1, task, {
        mode: 'ask',
        content: '看看',
        expertRefs: ['cardiovascular'],
        twinRefs: [{ kind: 'metric', code: 'uric_acid' }],
      }).expect(404);
      await send(a1, task, { ...base, followUpItemId: followUpA1 }).expect(429);
      expect(provider.calls).toHaveLength(0);
    });

    it('T2/T4 重新请、补请：别人的调用 404；孪生项已不可用（预测没了）404，不调用模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, task, {
        mode: 'ask',
        content: '',
        twinRefs: [{ kind: 'metric', code: 'sbp' }],
        twinConsult: true,
      }).expect(200);
      const [c] = await consultationsOf(task);
      for (const u of [f.users.managerA2, f.users.managerB1]) {
        const other = await as(u.email);
        await other.post(`/api/expert-consultations/${c!.id}/reconsult`).send({}).expect(404);
        await other
          .post(`/api/expert-consultations/${c!.id}/add-expert`)
          .send({ expertId: 'nutrition' })
          .expect(404);
      }
      // 预测被替换掉（没有当前预测）：原来的孪生项不能再用
      await owner
        .updateTable('twin_forecasts')
        .set({ superseded_at: new Date() })
        .where('client_id', '=', f.clients.a1[0])
        .execute();
      provider.calls.length = 0;
      const before = (await messagesOf(task)).length;
      await a1.post(`/api/expert-consultations/${c!.id}/reconsult`).send({}).expect(404);
      expect(provider.calls).toHaveLength(0);
      expect(await messagesOf(task)).toHaveLength(before);
      expect(await consultationsOf(task)).toHaveLength(1);
    });
  });
});
