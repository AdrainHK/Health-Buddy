import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { DISCLAIMER, type TaskStreamEvent } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 按顺序返回结构化输出的模拟厂商，记录每次收到的请求（全部是合成数据） */
class ScriptedProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  queue: { text: string; finishReason?: 'complete' | 'refused' }[] = [];

  async *stream(req: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const script = this.queue.shift() ?? { text: '{}' };
    await Promise.resolve();
    yield { type: 'text', delta: script.text };
    yield {
      type: 'done',
      finishReason: script.finishReason ?? 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }
}

const interpretationJson = (
  options: {
    clientFacing?: string;
    riskTier?: { tier: 'high' | 'medium' | 'low'; reasons: string[] } | null;
  } = {},
) =>
  JSON.stringify({
    professional: {
      overview: '该客户这次报告有一项高于参考范围。',
      abnormalFindings: [{ indicator: '空腹血糖', observation: '比上次有所上升。' }],
      comparison: ['空腹血糖 2026-01-01 5.5 → 2026-09-12 6.5 mmol/L'],
      referralAdvice: null,
      riskTier:
        options.riskTier === undefined
          ? { tier: 'medium', reasons: ['空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1'] }
          : options.riskTier,
      toUnderstand: [],
      missingData: [],
      interviewPoints: ['近期饮食'],
      suggestions: ['三个月后复查空腹血糖'],
    },
    clientFacing:
      options.clientFacing ??
      '您好，这次体检空腹血糖 6.5 mmol/L，略高于报告上的参考范围（3.9-6.1）。建议晚餐少吃甜食，每周快走三次。有疑问请联系您的健管师。',
    crisisSignal: false,
  });

const outlineJson = () =>
  JSON.stringify({
    professional: {
      overview: '重点了解饮食和运动。',
      groups: [
        {
          topic: 'diet',
          questions: [
            { question: '您晚餐一般吃些什么？', why: '空腹血糖 6.5 mmol/L 高于报告参考范围' },
          ],
        },
      ],
      missingData: [],
      suggestions: [],
    },
    crisisSignal: false,
  });

function parseSse(text: string): TaskStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as TaskStreamEvent);
}

/**
 * /体检解读、/面谈提纲、建议分层和多步计划（M2 规格 2.5–2.9、3.4，验收标准 4、7、10–14、16）。
 */
describe('体检解读、面谈提纲、建议分层和多步计划', () => {
  const owner = ownerDb();
  const provider = new ScriptedProvider();
  const noGuideProvider = new ScriptedProvider();
  /** 线上配置：带通用默认分层定义（DEFAULT_RISK_TIER_GUIDE） */
  let app: INestApplication;
  /** 去掉了分层定义的实例：不给建议分层，模型给出的分层也丢弃 */
  let noGuideApp: INestApplication;
  let f: Fixtures;
  /** A1 第一位客户的第二份已核对报告（2026-09-12，比种子里 2026-01-01 那份新） */
  let reportA1: string;
  let reportB1: string;

  async function insertReport(clientId: string, date: string, fpg: number) {
    const report = await owner
      .insertInto('health_reports')
      .values({ client_id: clientId, report_date: date, title: '合成报告', source: 'synthetic' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await owner
      .insertInto('report_indicators')
      .values([
        {
          report_id: report.id,
          client_id: clientId,
          code: 'fpg',
          value: fpg,
          unit: 'mmol/L',
          ref_low: 3.9,
          ref_high: 6.1,
          ref_text: '3.9-6.1',
          abnormal: fpg > 6.1 ? 'high' : 'normal',
        },
        {
          report_id: report.id,
          client_id: clientId,
          code: null,
          raw_name: '同型半胱氨酸',
          value: 12,
          unit: 'umol/L',
          abnormal: 'no_reference',
        },
      ])
      .execute();
    return report.id as string;
  }

  const as = (email: string, target = app) => loginAs(target, email);
  const newTask = async (agent: Agent, clientId: string) =>
    (await agent.post('/api/tasks').send({ clientId }).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const interpret = (agent: Agent, taskId: string, reportRefs: string[] = []) =>
    send(agent, taskId, {
      mode: 'craft',
      content: '帮我解读一下这份报告',
      skillId: 'report-interpretation',
      reportRefs,
    });
  const artifactsOf = (taskId: string) =>
    owner
      .selectFrom('artifacts')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at')
      .execute();
  const detail = async (agent: Agent, id: string) =>
    (await agent.get(`/api/artifacts/${id}`).expect(200)).body;
  const approve = (agent: Agent, id: string, body: Record<string, unknown> = {}) =>
    detail(agent, id).then((d) =>
      agent.post(`/api/artifacts/${id}/approve`).send({
        version: d.artifact.version,
        contentHash: d.artifact.contentHash,
        ...body,
      }),
    );
  const tiersOf = (clientId: string) =>
    owner
      .selectFrom('client_risk_tiers')
      .selectAll()
      .where('client_id', '=', clientId)
      .orderBy('set_at')
      .execute();

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
    noGuideApp = await createTestApp(
      {},
      { llmProviders: { openai: noGuideProvider }, riskTierCriteria: null },
    );
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    reportA1 = await insertReport(f.clients.a1[0], '2026-09-12', 6.5);
    reportB1 = await insertReport(f.clients.b1, '2026-09-12', 6.5);
    for (const p of [provider, noGuideProvider]) {
      p.queue = [];
      p.calls.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await noGuideApp.close();
    await owner.destroy();
  });

  describe('/体检解读（规格 2.5、2.6）', () => {
    it('@ 报告生成解读草稿：步骤写明报告日期，后端写出异常项表，通俗版带称呼和免责声明', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      const res = await interpret(agent, taskId, [reportA1]).expect(200);
      const events = parseSse(res.text);
      const steps = events.flatMap((e) =>
        e.type === 'step' && e.step.status !== 'running' ? [e.step] : [],
      );
      expect(steps.map((s) => [s.kind, s.labelKey, s.status])).toEqual([
        ['read_report', 'steps.readReport', 'done'],
        ['compare_reports', 'steps.compareReports', 'done'],
        ['detect_critical', 'steps.detectCritical', 'done'],
        ['run_skill', 'steps.generateInterpretation', 'done'],
      ]);
      expect(steps[0]?.labelDate).toBe('2026-09-12');
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
      // 规格 4.1：/体检解读 用 report_interpretation 用途；M2 不调用专家（Q15）
      expect(provider.calls.map((c) => c.route)).toEqual(['report_interpretation']);
      expect(JSON.stringify(events)).not.toContain('专家');

      const artifact = (await artifactsOf(taskId))[0]!;
      expect(artifact).toMatchObject({
        skill_id: 'report-interpretation',
        kind: 'report_interpretation',
        status: 'draft',
        source_report_id: reportA1,
        // 按默认分层定义给出建议分层，只给健管师看（规格 2.7、Q8）
        risk_tier_suggestion: {
          tier: 'medium',
          reason: '空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1',
        },
      });
      const content = artifact.content as { professional: string; clientFacing: string };
      expect(content.professional).toContain(
        '- **空腹血糖**：6.5 mmol/L，高于参考范围（报告参考范围：3.9-6.1）；上次 2026-01-01 5.5 mmol/L',
      );
      expect(content.professional).toContain(
        '同型半胱氨酸（未收录指标）：12 umol/L（报告未提供参考范围）',
      );
      expect(content.professional).toContain('建议分层：**中**');
      expect(content.clientFacing).not.toMatch(/分层|中风险/);
      expect(content.clientFacing.startsWith('测试客户 A1-1，您好！')).toBe(true);
      expect(content.clientFacing.endsWith(DISCLAIMER)).toBe(true);

      const d = await detail(agent, artifact.id);
      expect(d.artifact).toMatchObject({
        sourceReportId: reportA1,
        riskTierSuggestion: { tier: 'medium' },
      });
      expect(d.sourceReport).toEqual({
        id: reportA1,
        reportDate: '2026-09-12',
        correctedSince: false,
      });
    });

    it('没有 @ 报告时用最近一份已核对报告；客户没有已核对报告时 409，不生成', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      const res = await interpret(agent, taskId).expect(200);
      const read = parseSse(res.text).find(
        (e) => e.type === 'step' && e.step.kind === 'read_report' && e.step.status === 'done',
      );
      expect(read).toMatchObject({ step: { labelDate: '2026-09-12' } });
      expect((await artifactsOf(taskId))[0]?.source_report_id).toBe(reportA1);

      // A1 的第二位客户没有任何报告
      const empty = await newTask(agent, f.clients.a1[1]);
      const rejected = await interpret(agent, empty).expect(409);
      expect(rejected.body).toEqual({ error: 'conflict', reasons: ['no_verified_report'] });
      const messages = await owner
        .selectFrom('task_messages')
        .select('id')
        .where('task_id', '=', empty)
        .execute();
      expect(messages).toEqual([]);
      expect(provider.calls).toHaveLength(1);

      // /面谈提纲 报告可选（验收反馈）：没有已核对报告时按档案生成，不依据任何报告
      provider.queue.push({ text: outlineJson() });
      const outline = await send(agent, empty, {
        mode: 'craft',
        content: '列提纲',
        skillId: 'interview-outline',
      }).expect(200);
      const steps = parseSse(outline.text).flatMap((e) =>
        e.type === 'step' && e.step.status === 'done' ? [e.step.kind] : [],
      );
      expect(steps).toEqual(['read_client', 'detect_critical', 'run_skill']);
      expect(JSON.stringify(provider.calls[1]?.messages)).toContain('没有已核对的体检报告');
      const [drafted] = await artifactsOf(empty);
      expect(drafted).toMatchObject({ kind: 'interview_outline', source_report_id: null });
      expect((drafted?.content as { professional: string }).professional).toContain(
        '依据：客户档案',
      );
    });

    it('产物摘要带依据报告的日期（标题用）；客户转出后看不到报告，日期为空', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const before = (await agent.get(`/api/tasks/${taskId}`).expect(200)).body.artifacts;
      // 直接写进库的报告没有上传记录，没有文件名
      expect(before).toEqual([
        expect.objectContaining({ sourceReportDate: '2026-09-12', sourceFileName: null }),
      ]);
      const artifactId = before[0].id as string;
      expect(
        (await agent.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact,
      ).toMatchObject({ sourceReportDate: '2026-09-12' });
      // 别的健管师看不到这份产物
      const a2 = await as(f.users.managerA2.email);
      await a2.get(`/api/tasks/${taskId}`).expect(404);
      await a2.get(`/api/artifacts/${artifactId}`).expect(404);

      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      // 任务和已作废的产物仍归 A1，但报告已跟着客户转走：标题用的日期和文件名都取不到
      const after = (await agent.get(`/api/tasks/${taskId}`).expect(200)).body.artifacts;
      expect(after).toEqual([
        expect.objectContaining({ status: 'voided', sourceReportDate: null, sourceFileName: null }),
      ]);
    });

    it('/面谈提纲 不选报告时用最近一份已核对报告，@ 了报告就用那一份', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: outlineJson() });
      const res = await send(agent, taskId, {
        mode: 'craft',
        content: '',
        skillId: 'interview-outline',
      }).expect(200);
      const read = parseSse(res.text).find(
        (e) => e.type === 'step' && e.step.kind === 'read_report' && e.step.status === 'done',
      );
      expect(read).toMatchObject({ step: { labelDate: '2026-09-12' } });
      expect((await artifactsOf(taskId))[0]?.source_report_id).toBe(reportA1);
      // 别的客户的报告仍是 404
      const other = await newTask(agent, f.clients.a1[1]);
      await send(agent, other, {
        mode: 'craft',
        content: '',
        skillId: 'interview-outline',
        reportRefs: [reportA1],
      }).expect(404);
    });

    it('/面谈提纲 在想一想里：客户没有已核对报告也能出计划并执行', async () => {
      const agent = await as(f.users.managerA1.email);
      const empty = await newTask(agent, f.clients.a1[1]);
      const proposed = await send(agent, empty, {
        mode: 'plan',
        content: '列提纲',
        skillId: 'interview-outline',
      }).expect(200);
      const plan = parseSse(proposed.text).find((e) => e.type === 'plan');
      provider.queue.push({ text: outlineJson() });
      await agent
        .post(`/api/tasks/${empty}/plans/${plan?.type === 'plan' ? plan.plan.id : ''}/confirm`)
        .expect(200);
      const artifacts = await artifactsOf(empty);
      expect(artifacts.map((a) => [a.skill_id, a.source_report_id])).toEqual([
        ['interview-outline', null],
      ]);
      // 退回重写：仍不依据报告
      provider.queue.push({ text: outlineJson() });
      await agent
        .post(`/api/artifacts/${artifacts[0]!.id}/return`)
        .send({ reason: '多问一些睡眠的问题' })
        .expect(200);
      expect((await artifactsOf(empty)).map((a) => a.source_report_id)).toEqual([null, null]);
    });

    it('验收反馈 8：/体检解读 不写要求也能发送，后端用默认要求；没有技能时内容不能为空', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await send(agent, taskId, {
        mode: 'craft',
        content: '',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
      }).expect(200);
      expect(JSON.stringify(provider.calls[0])).toContain('请解读这份体检报告');
      const saved = await owner
        .selectFrom('task_messages')
        .select(['role', 'content'])
        .where('task_id', '=', taskId)
        .where('role', '=', 'manager')
        .execute();
      expect(saved).toEqual([{ role: 'manager', content: '请解读这份体检报告' }]);
      expect(await artifactsOf(taskId)).toHaveLength(1);

      // 没有技能：空内容是无效请求；只写空格也一样
      await send(agent, taskId, { mode: 'craft', content: '' }).expect(400);
      await send(agent, taskId, { mode: 'ask', content: '   ' }).expect(400);
      // 空内容也照样校验报告：/体检解读 在客户没有已核对报告时 409
      const empty = await newTask(agent, f.clients.a1[1]);
      const rejected = await send(agent, empty, {
        mode: 'craft',
        content: '',
        skillId: 'report-interpretation',
      }).expect(409);
      expect(rejected.body.reasons).toEqual(['no_verified_report']);
      expect(provider.calls).toHaveLength(1);
    });

    it('验收 4：用未核对的识别结果、别的客户或别的健管师的报告做解读，一律 404', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      // 待核对的识别结果不在正式报告里
      const upload = await owner
        .insertInto('report_uploads')
        .values({
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
          client_id: f.clients.a1[0],
          status: 'needs_review',
          page_count: 1,
          uploaded_by: f.users.managerA1.id,
          requested_by: f.users.managerA1.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await interpret(agent, taskId, [upload.id as string]).expect(404);
      // 协会 B 的报告
      await interpret(agent, taskId, [reportB1]).expect(404);
      // 自己另一位客户的报告
      const other = await insertReport(f.clients.a1[1], '2026-08-01', 5.0);
      await interpret(agent, taskId, [other]).expect(404);
      // 同协会别的健管师用 A1 的任务
      const a2 = await as(f.users.managerA2.email);
      await interpret(a2, taskId, [reportA1]).expect(404);
      // 机构管理员、运营商、平台都不能调用
      for (const email of [
        f.users.orgAdminA.email,
        f.users.operatorAdminA.email,
        f.users.platform.email,
      ]) {
        const other = await as(email);
        const res = await interpret(other, taskId, [reportA1]);
        expect([403, 404]).toContain(res.status);
      }
      expect(provider.calls).toEqual([]);
    });

    it('验收 16：发给模型的提示词里没有客户姓名和联系方式（健康史和要求里的也去掉）', async () => {
      const agent = await as(f.users.managerA1.email);
      await agent
        .post(`/api/clients/${f.clients.a1[0]}/health-history`)
        .send({
          category: 'family_history',
          content: '测试客户 A1-1 的母亲有血糖偏高，联系电话 13800001234',
        })
        .expect(201);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await send(agent, taskId, {
        mode: 'craft',
        content: '帮测试客户 A1-1 解读报告，她电话 139 0000 1111',
        skillId: 'report-interpretation',
        reportRefs: [reportA1],
      }).expect(200);
      const prompt = JSON.stringify(provider.calls[0]);
      for (const leak of ['测试客户 A1-1', '13800001234', '139 0000 1111', 'A1-1']) {
        expect(prompt).not.toContain(leak);
      }
      expect(prompt).toContain('该客户 的母亲有血糖偏高');
      expect(prompt).toContain('[电话]');
      expect(prompt).toContain('空腹血糖：6.5 mmol/L');
    });

    it('验收 7：危急指标进专业版和审核栏，确认要勾选已知悉；通俗版写了危急数值不能确认', async () => {
      const agent = await as(f.users.managerA1.email);
      const critical = await insertReport(f.clients.a1[0], '2026-10-01', 17.2);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({
        text: interpretationJson({ clientFacing: '您好，这次空腹血糖 17.2，请注意饮食。' }),
      });
      await interpret(agent, taskId, [critical]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      const content = artifact.content as { professional: string; clientFacing: string };
      expect(content.professional).toContain(
        '## 危急指标\n**本报告有危急指标，请先电话联系客户。**',
      );
      expect(content.professional).toContain(
        '空腹血糖 17.2 mmol/L（2026-10-01，体检报告）：需尽快就医',
      );
      const d = await detail(agent, artifact.id);
      expect(d.artifact.criticalFlags).toHaveLength(1);
      const res = await approve(agent, artifact.id, { acknowledgedCritical: true });
      expect(res.status).toBe(409);
      expect(res.body.reasons).toEqual(['critical_value_in_client_text']);
      const noAck = await approve(agent, artifact.id);
      expect(noAck.status).toBe(409);
      expect(noAck.body.reasons).toContain('critical_not_acknowledged');
    });

    it('Q20：通俗版出现风险分层字样不能确认（含插空格、全角）', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({
        text: interpretationJson({ clientFacing: '您好，您目前属于中 风险人群，建议多运动。' }),
      });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      const d = await detail(agent, artifact.id);
      expect(d.hints.riskTierMentions.map((m: { text: string }) => m.text)).toEqual([
        '中 风险人群',
      ]);
      const res = await approve(agent, artifact.id);
      expect(res.status).toBe(409);
      expect(res.body.reasons).toEqual(['risk_tier_in_client_text']);
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);
    });

    it('报告数值更正后，草稿详情提示依据的报告已更正（规格 2.4）', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      await owner
        .insertInto('report_indicators')
        .values({
          report_id: reportA1,
          client_id: f.clients.a1[0],
          code: 'tg',
          value: 1.2,
          unit: 'mmol/L',
          created_at: new Date(Date.now() + 1000),
        })
        .execute();
      expect((await detail(agent, artifact.id)).sourceReport.correctedSince).toBe(true);
    });

    it('退回重写沿用原来的报告；导出文件名是“体检报告解读 日期 第几版”，不含客户姓名，不含分层', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const first = (await artifactsOf(taskId))[0]!;
      // 之后又有了一份更新的报告：重写仍用原来那份
      await insertReport(f.clients.a1[0], '2026-10-05', 5.0);
      provider.queue.push({ text: interpretationJson() });
      await agent
        .post(`/api/artifacts/${first.id}/return`)
        .send({ reason: '语气再温和一点' })
        .expect(200);
      const second = (await artifactsOf(taskId)).at(-1);
      expect(second).toMatchObject({ version: 2, source_report_id: reportA1 });
      expect(JSON.stringify(provider.calls[1])).toContain('报告日期：2026-09-12');

      const approved = await approve(agent, second!.id);
      expect(approved.status).toBe(200);
      const pdf = await agent.post(`/api/artifacts/${second!.id}/export`).send({ format: 'pdf' });
      expect(pdf.status).toBe(200);
      const disposition = decodeURIComponent(pdf.headers['content-disposition'] ?? '');
      expect(disposition).toMatch(/体检报告解读 \d{4}-\d{2}-\d{2} 第2版\.pdf/);
      expect(disposition).not.toContain('测试客户');
      const copy = await agent.post(`/api/artifacts/${second!.id}/copy`).expect(200);
      expect(copy.body.text).not.toMatch(/分层|风险/);
      expect(copy.body.text).not.toContain('建议分层');
    });

    it('依据的报告已不可用时不能退回重写，不会换成最近一份报告', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const first = (await artifactsOf(taskId))[0]!;
      await owner.deleteFrom('health_reports').where('id', '=', reportA1).execute();
      expect((await artifactsOf(taskId))[0]?.source_report_id).toBeNull();
      const res = await agent
        .post(`/api/artifacts/${first.id}/return`)
        .send({ reason: '语气再温和一点' });
      expect(res.status).toBe(409);
      expect(res.body.reasons).toEqual(['source_report_unavailable']);
      expect(provider.calls).toHaveLength(1);
      expect((await artifactsOf(taskId)).map((a) => [a.version, a.status])).toEqual([[1, 'draft']]);
    });
  });

  describe('建议分层（规格 2.7，验收 12）', () => {
    it('分层定义被去掉时不给建议：模型给了分层也丢弃，勾选采用被拒绝', async () => {
      const agent = await as(f.users.managerA1.email, noGuideApp);
      const taskId = await newTask(agent, f.clients.a1[0]);
      noGuideProvider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      expect(JSON.stringify(noGuideProvider.calls[0])).toContain('没有提供分层标准');
      const artifact = (await artifactsOf(taskId))[0]!;
      expect(artifact.risk_tier_suggestion).toBeNull();
      expect((artifact.content as { professional: string }).professional).toContain(
        '没有提供分层标准，这次不给出建议分层。',
      );
      const res = await approve(agent, artifact.id, { adoptRiskTier: true });
      expect(res.status).toBe(409);
      expect(res.body.reasons).toEqual(['no_risk_tier_suggestion']);
    });

    it('按默认定义保存建议；确认时勾选“采用建议分层”写入分层历史，来源是这份产物', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      // 发给模型的是通用默认分层定义（DEFAULT_RISK_TIER_GUIDE）
      expect(JSON.stringify(provider.calls[0])).toContain('通用默认分层定义');
      const artifact = (await artifactsOf(taskId))[0]!;
      expect(artifact.risk_tier_suggestion).toEqual({
        tier: 'medium',
        reason: '空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1',
      });
      const content = artifact.content as { professional: string; clientFacing: string };
      expect(content.professional).toContain('建议分层：**中**');
      expect(content.clientFacing).not.toMatch(/分层|中风险/);

      const res = await approve(agent, artifact.id, { adoptRiskTier: true });
      expect(res.status).toBe(200);
      const tiers = await tiersOf(f.clients.a1[0]);
      expect(tiers).toHaveLength(1);
      expect(tiers[0]).toMatchObject({
        tier: 'medium',
        reason: '空腹血糖 6.5 mmol/L 高于报告参考范围 3.9-6.1',
        source: 'artifact',
        source_artifact_id: artifact.id,
        set_by: f.users.managerA1.id,
        manager_id: f.users.managerA1.id,
      });
      const history = await agent.get(`/api/clients/${f.clients.a1[0]}/risk-tiers`).expect(200);
      expect(history.body.tiers[0]).toMatchObject({
        source: 'artifact',
        sourceArtifactId: artifact.id,
      });
      // 机构管理员看得到分层，看不到来源产物（Q14）
      const orgAdmin = await as(f.users.orgAdminA.email);
      const seen = await orgAdmin.get(`/api/clients/${f.clients.a1[0]}/risk-tiers`).expect(200);
      expect(seen.body.tiers[0]).toMatchObject({ source: 'artifact', sourceArtifactId: null });
    });

    it('不勾选不改分层；产物没有建议分层时勾选被拒绝；手动修改仍要理由', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      expect((await approve(agent, artifact.id)).status).toBe(200);
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);

      const task2 = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson({ riskTier: null }) });
      await interpret(agent, task2, [reportA1]).expect(200);
      const noSuggestion = (await artifactsOf(task2))[0]!;
      const rejected = await approve(agent, noSuggestion.id, { adoptRiskTier: true });
      expect(rejected.status).toBe(409);
      expect(rejected.body.reasons).toEqual(['no_risk_tier_suggestion']);
      expect((await detail(agent, noSuggestion.id)).artifact.status).toBe('draft');
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);

      await agent
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'low' })
        .expect(400);
    });

    it('跨租户：别人不能确认这份产物，也就不能借它给客户写分层', async () => {
      const a1 = await as(f.users.managerA1.email);
      const taskId = await newTask(a1, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(a1, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      const d = await detail(a1, artifact.id);
      for (const email of [
        f.users.managerA2.email,
        f.users.managerB1.email,
        f.users.orgAdminA.email,
        f.users.operatorAdminA.email,
        f.users.operatorAdminB.email,
        f.users.platform.email,
      ]) {
        const other = await as(email);
        const res = await other.post(`/api/artifacts/${artifact.id}/approve`).send({
          version: d.artifact.version,
          contentHash: d.artifact.contentHash,
          adoptRiskTier: true,
        });
        expect([403, 404]).toContain(res.status);
      }
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);
    });

    it('确认并采用建议分层和客户转出并发：先锁客户再锁任务，不会死锁', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      const d = await detail(agent, artifact.id);

      // 模拟正在进行的转出：先锁住客户行（和 UPDATE clients 一样的行锁）
      let result: Promise<{ status: number }> = Promise.resolve({ status: 0 });
      await owner.transaction().execute(async (trx) => {
        await trx
          .selectFrom('clients')
          .select('id')
          .where('id', '=', f.clients.a1[0])
          .forUpdate()
          .execute();
        const pending = agent.post(`/api/artifacts/${artifact.id}/approve`).send({
          version: d.artifact.version,
          contentHash: d.artifact.contentHash,
          adoptRiskTier: true,
        });
        result = pending.then((r) => r);
        // 等确认请求在客户行上等锁
        for (let i = 0; i < 50; i++) {
          const waiting = await owner
            .selectFrom('pg_stat_activity' as never)
            .select(sql<number>`count(*)::int`.as('n'))
            .where(sql<boolean>`wait_event_type = 'Lock' and datname = current_database()`)
            .executeTakeFirstOrThrow();
          if ((waiting as { n: number }).n > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        // 转出接着锁任务（detach_client_work 的顺序）。确认请求如果先拿了任务锁，这里会等到超时
        await sql`set local lock_timeout = '3s'`.execute(trx);
        await trx
          .selectFrom('tasks')
          .select('id')
          .where('client_id', '=', f.clients.a1[0])
          .forUpdate()
          .execute();
        await trx
          .updateTable('clients')
          .set({ manager_id: f.users.managerA2.id })
          .where('id', '=', f.clients.a1[0])
          .execute();
      });
      // 转出提交后，等锁的确认请求按只读拒绝，不会写入分层
      expect([404, 409]).toContain((await result).status);
      expect((await artifactsOf(taskId))[0]?.status).toBe('voided');
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);
    });

    it('客户转出后：分层跟着客户走，来源产物的引用置空，来源仍记为“采用建议分层”', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: interpretationJson() });
      await interpret(agent, taskId, [reportA1]).expect(200);
      const artifact = (await artifactsOf(taskId))[0]!;
      expect((await approve(agent, artifact.id, { adoptRiskTier: true })).status).toBe(200);
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      const [tier] = await tiersOf(f.clients.a1[0]);
      expect(tier).toMatchObject({
        manager_id: f.users.managerA2.id,
        source: 'artifact',
        source_artifact_id: null,
      });
      const after = await owner
        .selectFrom('artifacts')
        .select(['client_id', 'source_report_id'])
        .where('id', '=', artifact.id)
        .executeTakeFirstOrThrow();
      // 原健管师的产物不再指向这位客户的报告（T2）
      expect(after).toEqual({ client_id: null, source_report_id: null });
      const old = await as(f.users.managerA1.email);
      expect((await detail(old, artifact.id)).sourceReport).toBeNull();
      // 客户删除时也不因为引用而失败
      await owner.deleteFrom('clients').where('id', '=', f.clients.a1[0]).execute();
      expect(await tiersOf(f.clients.a1[0])).toEqual([]);
    });
  });

  describe('/面谈提纲（规格 2.8，验收 13）', () => {
    it('只有专业版的草稿：可以修改和确认，复制和导出返回 409', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push({ text: outlineJson() });
      const res = await send(agent, taskId, {
        mode: 'craft',
        content: '列一份面谈提纲',
        skillId: 'interview-outline',
      }).expect(200);
      const steps = parseSse(res.text).flatMap((e) =>
        e.type === 'step' && e.step.status === 'done' ? [e.step.kind] : [],
      );
      expect(steps).toEqual(['read_report', 'detect_critical', 'run_skill']);
      expect(provider.calls[0]?.route).toBe('skill');
      expect(provider.calls[0]?.system).not.toContain('通俗版（clientFacing');
      const artifact = (await artifactsOf(taskId))[0]!;
      expect(artifact).toMatchObject({ kind: 'interview_outline', source_report_id: reportA1 });
      expect((artifact.content as { clientFacing: string }).clientFacing).toBe('');

      // 修改专业版：通俗版仍为空，不会被拼上免责声明
      let d = await detail(agent, artifact.id);
      const edited = await agent
        .patch(`/api/artifacts/${artifact.id}`)
        .send({
          version: d.artifact.version,
          contentHash: d.artifact.contentHash,
          content: {
            professional: `${d.artifact.content.professional}\n- 补充一个问题`,
            clientFacing: '您好',
          },
        })
        .expect(200);
      expect(edited.body.artifact.content.clientFacing).toBe('');
      expect(edited.body.artifact.clientFacing).toBe(false);
      d = edited.body;
      const approved = await agent
        .post(`/api/artifacts/${artifact.id}/approve`)
        .send({ version: d.artifact.version, contentHash: d.artifact.contentHash });
      expect(approved.status).toBe(200);
      expect(approved.body.artifact.status).toBe('approved');

      const copy = await agent.post(`/api/artifacts/${artifact.id}/copy`).expect(409);
      expect(copy.body.reasons).toEqual(['not_client_facing']);
      for (const format of ['png', 'pdf']) {
        const ex = await agent
          .post(`/api/artifacts/${artifact.id}/export`)
          .send({ format })
          .expect(409);
        expect(ex.body.reasons).toEqual(['not_client_facing']);
      }
      // 别人的提纲：404，不是 409
      const a2 = await as(f.users.managerA2.email);
      await a2.post(`/api/artifacts/${artifact.id}/copy`).expect(404);
      await a2.post(`/api/artifacts/${artifact.id}/export`).send({ format: 'pdf' }).expect(404);
    });
  });

  describe('/面谈提纲 保存前的措辞检查（规格 2.8）', () => {
    const outlineWith = (question: string) =>
      JSON.stringify({
        ...JSON.parse(outlineJson()),
        professional: {
          ...JSON.parse(outlineJson()).professional,
          groups: [{ topic: 'family', questions: [{ question, why: '空腹血糖 6.5 mmol/L' }] }],
        },
      });
    const outline = (agent: Agent, taskId: string) =>
      send(agent, taskId, {
        mode: 'craft',
        content: '列个面谈提纲',
        skillId: 'interview-outline',
        reportRefs: [reportA1],
      });

    it('第一次点名了疾病：带纠正说明重新生成一次，通过后保存', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push(
        { text: outlineWith('家里有人得过糖尿病吗？') },
        { text: outlineWith('家里的长辈有没有血糖方面的问题？') },
      );
      const res = await outline(agent, taskId).expect(200);
      expect(provider.calls).toHaveLength(2);
      const retry = JSON.stringify(provider.calls[1]?.messages);
      expect(retry).toContain('没有通过措辞检查');
      // 纠正说明不复述上次的输出
      expect(retry).not.toContain('家里有人得过');
      const artifacts = await artifactsOf(taskId);
      expect(artifacts).toHaveLength(1);
      expect((artifacts[0]!.content as { professional: string }).professional).not.toContain(
        '糖尿病',
      );
      expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    });

    it('跟进建议里给了用药建议：同样重新生成一次', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      const withSuggestion = (suggestion: string) =>
        JSON.stringify({
          ...JSON.parse(outlineJson()),
          professional: { ...JSON.parse(outlineJson()).professional, suggestions: [suggestion] },
        });
      provider.queue.push(
        { text: withSuggestion('未按要求：建议换成二甲双胍') },
        { text: withSuggestion('未按要求给出用药建议，原因：用药调整需由医生评估') },
      );
      await outline(agent, taskId).expect(200);
      expect(provider.calls).toHaveLength(2);
      expect(JSON.stringify(provider.calls[1]?.messages)).toContain('用药建议或剂量');
      expect(JSON.stringify(provider.calls[1]?.messages)).not.toContain('换成二甲双胍');
      expect(await artifactsOf(taskId)).toHaveLength(1);
    });

    it('两次都没通过：不保存草稿，提示措辞检查没通过', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      provider.queue.push(
        { text: outlineWith('您的高血压是什么时候诊断的？') },
        { text: outlineWith('做过糖尿病筛查吗？') },
      );
      const res = await outline(agent, taskId).expect(200);
      const events = parseSse(res.text);
      expect(provider.calls).toHaveLength(2);
      expect(events).toContainEqual({ type: 'error', kind: 'wording_check_failed' });
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'error' });
      expect(events.some((e) => e.type === 'artifact')).toBe(false);
      expect(await artifactsOf(taskId)).toEqual([]);
    });
  });

  describe('想一想“新客户完整评估”（规格 2.9、Q22，验收 14）', () => {
    it('先出计划；确认后依次生成解读和提纲两份草稿', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      const proposed = await send(agent, taskId, {
        mode: 'plan',
        content: '新客户，帮我做个完整评估',
        skillId: 'new-client-assessment',
      }).expect(200);
      const planEvent = parseSse(proposed.text).find((e) => e.type === 'plan');
      expect(planEvent).toMatchObject({
        plan: {
          status: 'proposed',
          steps: [
            { kind: 'read_client' },
            { kind: 'run_skill', skillId: 'report-interpretation' },
            { kind: 'run_skill', skillId: 'interview-outline' },
          ],
        },
      });
      expect(provider.calls).toEqual([]);
      const planId = planEvent?.type === 'plan' ? planEvent.plan.id : '';

      // 别人不能确认这份计划
      const a2 = await as(f.users.managerA2.email);
      await a2.post(`/api/tasks/${taskId}/plans/${planId}/confirm`).expect(404);

      provider.queue.push({ text: interpretationJson() }, { text: outlineJson() });
      const res = await agent.post(`/api/tasks/${taskId}/plans/${planId}/confirm`).expect(200);
      const events = parseSse(res.text);
      expect(events.filter((e) => e.type === 'artifact')).toHaveLength(2);
      expect(
        events.flatMap((e) =>
          e.type === 'step' && e.step.status === 'done' ? [e.step.labelKey] : [],
        ),
      ).toEqual([
        'steps.readReport',
        'steps.compareReports',
        'steps.detectCritical',
        'steps.generateInterpretation',
        'steps.generateOutline',
      ]);
      expect(provider.calls.map((c) => c.route)).toEqual(['report_interpretation', 'skill']);
      const artifacts = await artifactsOf(taskId);
      expect(artifacts.map((a) => [a.skill_id, a.status, a.version, a.source_report_id])).toEqual([
        ['report-interpretation', 'draft', 1, reportA1],
        ['interview-outline', 'draft', 1, reportA1],
      ]);
      // 两份草稿各自是一条产物链
      expect(artifacts[0]?.lineage_id).not.toBe(artifacts[1]?.lineage_id);

      // 其中一份退回重写，用的是当初的要求
      provider.queue.push({ text: outlineJson() });
      await agent
        .post(`/api/artifacts/${artifacts[1]!.id}/return`)
        .send({ reason: '多问一些运动的问题' })
        .expect(200);
      expect(JSON.stringify(provider.calls.at(-1))).toContain('新客户，帮我做个完整评估');
    });

    it('计划出好之后客户被转出：确认被拒绝，不生成草稿', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      const proposed = await send(agent, taskId, {
        mode: 'plan',
        content: '新客户，帮我做个完整评估',
        skillId: 'new-client-assessment',
      }).expect(200);
      const planEvent = parseSse(proposed.text).find((e) => e.type === 'plan');
      const planId = planEvent?.type === 'plan' ? planEvent.plan.id : '';
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      provider.queue.push({ text: interpretationJson() }, { text: outlineJson() });
      const res = await agent.post(`/api/tasks/${taskId}/plans/${planId}/confirm`);
      expect([404, 409]).toContain(res.status);
      expect(provider.calls).toEqual([]);
      expect(await artifactsOf(taskId)).toEqual([]);
      // 新健管师也不能确认原健管师的计划
      const a2 = await as(f.users.managerA2.email);
      await a2.post(`/api/tasks/${taskId}/plans/${planId}/confirm`).expect(404);
    });

    it('多步计划只能在想一想里用；客户没有已核对报告时不出计划', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      await send(agent, taskId, {
        mode: 'craft',
        content: '完整评估',
        skillId: 'new-client-assessment',
      }).expect(400);
      const empty = await newTask(agent, f.clients.a1[1]);
      const res = await send(agent, empty, {
        mode: 'plan',
        content: '完整评估',
        skillId: 'new-client-assessment',
      }).expect(409);
      expect(res.body.reasons).toEqual(['no_verified_report']);
    });

    it('第一步模型拒答时停止，不再生成提纲', async () => {
      const agent = await as(f.users.managerA1.email);
      const taskId = await newTask(agent, f.clients.a1[0]);
      const proposed = await send(agent, taskId, {
        mode: 'plan',
        content: '完整评估',
        skillId: 'new-client-assessment',
      }).expect(200);
      const plan = parseSse(proposed.text).find((e) => e.type === 'plan');
      provider.queue.push({ text: '', finishReason: 'refused' });
      const res = await agent
        .post(`/api/tasks/${taskId}/plans/${plan?.type === 'plan' ? plan.plan.id : ''}/confirm`)
        .expect(200);
      expect(parseSse(res.text).at(-1)).toMatchObject({ type: 'done', reason: 'refused' });
      expect(await artifactsOf(taskId)).toEqual([]);
      expect(provider.calls).toHaveLength(1);
    });
  });

  it('技能列表里有两个新技能和多步计划', async () => {
    const agent = await as(f.users.managerA1.email);
    const res = await agent.get('/api/skills').expect(200);
    const ids = res.body.skills.map((s: { id: string }) => s.id);
    // M4 第 4 步加了 /孪生小结 和“孪生复盘”；M5 第 5、6 步加了 /方案生成、/随访计划、/随访话术、/随访记录和“方案和随访”
    expect(ids).toEqual([
      'client-recent-summary',
      'report-interpretation',
      'interview-outline',
      'twin-summary',
      'care-plan',
      'visit-schedule',
      'visit-script',
      'visit-record',
      'new-client-assessment',
      'twin-review',
      'plan-and-visits',
    ]);
    // 都不需要再写要求（验收反馈 8）
    expect(
      res.body.skills.map((s: { allowsEmptyRequest: boolean }) => s.allowsEmptyRequest),
    ).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
    // /体检解读 必须有报告；/面谈提纲 报告可选（验收反馈）
    expect(
      res.body.skills.map((s: { id: string; requiresReport: boolean; usesReport: boolean }) => [
        s.id,
        s.requiresReport,
        s.usesReport,
      ]),
    ).toEqual([
      ['client-recent-summary', false, false],
      ['report-interpretation', true, true],
      ['interview-outline', false, true],
      ['twin-summary', false, false],
      ['care-plan', false, false],
      ['visit-schedule', false, false],
      ['visit-script', false, false],
      ['visit-record', false, false],
      ['new-client-assessment', true, true],
      ['twin-review', false, false],
      ['plan-and-visits', false, false],
    ]);
  });
});
