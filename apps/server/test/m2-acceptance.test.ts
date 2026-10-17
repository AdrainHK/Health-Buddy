import { randomUUID } from 'node:crypto';
import type {
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '@health-buddy/ai-engine';
import { generateDemoData, renderSamplePdf, writeDemoData } from '@health-buddy/seed';
import type { ReportUpload, ReportUploadStreamEvent, TaskStreamEvent } from '@health-buddy/shared';
import {
  REPORT_EXTRACTION_PROMPT,
  interviewOutline,
  reportExtractionEvalCases,
  reportInterpretation,
} from '@health-buddy/skills';
import { Logger, type INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type QueryExecutorProvider } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { InlineExtractionQueue } from '../src/reports/extraction-queue.js';
import { ReportsRepository } from '../src/reports/reports.repository.js';
import { InMemoryObjectStorage } from '../src/reports/storage.js';
import { TEST_APP_URL } from './env.js';
import { PASSWORD, ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { pageJson, syntheticPng, type ItemSpec } from './report-fixtures.js';

/**
 * M2 验收补齐（规格第五节）：
 * - 验收 24：用 scripts/seed 的合成数据走完上传 → 识别 → 核对 → 解读、提纲、多步计划，
 *   捕获日志、错误响应、SSE 错误事件、队列任务参数和埋点（计量和操作记录），搜不到敏感内容；
 * - 验收 18、19：第三节接口表逐行的跨租户拒绝测试，集中在一处；
 * - 验收 20：所有新表和扩展表逐表的行级安全（没有上下文、其他健管师上下文）；
 * - 验收 22：构造的队列任务读不到数据（不调模型、不读原件、不写结果）。
 * 全部是合成数据。
 */

type Agent = Awaited<ReturnType<typeof loginAs>>;

interface Script {
  text?: string;
  error?: Error;
  finishReason?: 'complete' | 'refused';
}

/** 按用途分别排队的模拟厂商：识别、解读、提纲各自取自己的脚本，记录每次请求 */
class RoutedProvider implements Provider {
  readonly name = 'openai' as const;
  readonly calls: GatewayRequest[] = [];
  private readonly queues = new Map<string, Script[]>();

  push(route: string, ...scripts: Script[]): void {
    this.queues.set(route, [...(this.queues.get(route) ?? []), ...scripts]);
  }

  async *stream(req: GatewayRequest, route: ResolvedRoute): AsyncIterable<GatewayEvent> {
    this.calls.push(req);
    const script = this.queues.get(req.route)?.shift() ?? {
      text: pageJson([], { category: 'not_a_report' }),
    };
    await Promise.resolve();
    if (script.error) throw script.error;
    if (script.text) yield { type: 'text', delta: script.text };
    yield {
      type: 'done',
      finishReason: script.finishReason ?? 'complete',
      usage: { inputTokens: 10, outputTokens: 10 },
      model: route.model,
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.queues.clear();
  }
}

/** 模型输出里的标记句：日志和埋点里搜这些，确认没有记下回答原文 */
const MODEL_OVERVIEW = '合成模型输出：血脂几项需要重点关注，晚餐后散步的习惯值得保持';
const MODEL_CLIENT_TEXT =
  '这次体检总胆固醇和低密度脂蛋白胆固醇比报告上的参考范围高一些，晚餐后散步的习惯值得保持。建议少吃油炸食物，每周快走三到五次。有疑问请随时联系您的健管师。';
const MODEL_QUESTION = '合成模型输出：您平时晚餐大概几点吃，口味偏咸还是偏淡？';
const MODEL_FINDING = '合成模型输出：异常项说明标记，比报告参考范围高一些';
const MODEL_TIER_REASON = '合成模型输出：分层依据标记，对应标准里的中';
const MODEL_WHY = '合成模型输出：提问理由标记，总胆固醇高于报告参考范围';

/** 从整段文字里均匀取几段（每段 24 个字），用来检查提示词有没有被整段或部分记下来 */
function slicesOf(text: string, count = 6, len = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(((text.length - len) * i) / (count - 1));
    const piece = text.slice(Math.max(start, 0), Math.max(start, 0) + len).trim();
    if (piece.length >= 10) out.push(piece);
  }
  return out;
}

const interpretationJson = (reasonValue: string) =>
  JSON.stringify({
    professional: {
      overview: MODEL_OVERVIEW,
      abnormalFindings: [{ indicator: '总胆固醇', observation: MODEL_FINDING }],
      comparison: ['没有之前同一单位的已核对数值，无法对比'],
      referralAdvice: null,
      riskTier: {
        tier: 'medium',
        reasons: [`总胆固醇 ${reasonValue} mmol/L 高于报告参考范围 <5.2，${MODEL_TIER_REASON}`],
      },
      toUnderstand: [],
      missingData: [],
      interviewPoints: ['了解晚餐习惯'],
      suggestions: ['三个月后复查血脂'],
    },
    clientFacing: MODEL_CLIENT_TEXT,
    crisisSignal: false,
  });

const outlineJson = () =>
  JSON.stringify({
    professional: {
      overview: '合成模型输出：重点了解饮食和运动。',
      groups: [
        {
          topic: 'diet',
          questions: [{ question: MODEL_QUESTION, why: MODEL_WHY }],
        },
      ],
      missingData: [],
      suggestions: [],
    },
    crisisSignal: false,
  });

function parseSse<T = TaskStreamEvent>(text: string): T[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as T);
}

/** 捕获 Nest 日志、console 和直接写到 stdout/stderr 的内容 */
function captureOutput() {
  const captured: string[] = [];
  const capture = (...args: unknown[]) => {
    captured.push(
      args
        .map((a) =>
          a instanceof Error
            ? `${a.name} ${a.message} ${a.stack}`
            : typeof a === 'string'
              ? a
              : Buffer.isBuffer(a)
                ? a.toString('utf8')
                : JSON.stringify(a),
        )
        .join(' '),
    );
  };
  const spies = [
    ...(['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).flatMap((m) => [
      vi.spyOn(Logger.prototype, m).mockImplementation(capture),
      vi.spyOn(Logger, m).mockImplementation(capture),
    ]),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(capture),
    ),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      capture(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      capture(chunk);
      return true;
    }),
  ];
  return {
    text: () => captured.join('\n'),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

describe('M2 验收补齐', () => {
  const owner = ownerDb();
  const provider = new RoutedProvider();
  const storage = new InMemoryObjectStorage();
  const queue = new InlineExtractionQueue();
  let app: INestApplication;
  let f: Fixtures;

  beforeAll(async () => {
    app = await createTestApp(
      {},
      {
        llmProviders: { openai: provider },
        reportInfra: { objectStorage: storage, extractionQueue: queue },
      },
    );
  });

  beforeEach(async () => {
    queue.resume();
    await queue.idle();
    f = await seedFixtures(owner);
    provider.reset();
    storage.objects.clear();
    queue.jobs.length = 0;
    queue.paused = false;
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  const newTask = async (agent: Agent, clientId: string) =>
    (await agent.post('/api/tasks').send({ clientId }).expect(201)).body.task.id as string;

  const verifyBody = (u: ReportUpload, reportDate: string) => ({
    version: u.version,
    checkedValueIds: u.values.filter((v) => v.attention).map((v) => v.id),
    reportDate,
  });

  /** 上传一张合成图片并识别完，返回待核对的识别记录 */
  async function extracted(
    agent: Agent,
    clientId: string,
    items: ItemSpec[],
    reportDate = '2026-05-01',
  ): Promise<ReportUpload> {
    provider.push('report_extraction', { text: pageJson(items, { reportDate }) });
    const res = await agent
      .post(`/api/clients/${clientId}/report-uploads`)
      .attach('files', syntheticPng(), { filename: 'synthetic.png', contentType: 'image/png' })
      .expect(201);
    await queue.idle();
    return (await agent.get(`/api/report-uploads/${res.body.upload.id}`).expect(200)).body
      .upload as ReportUpload;
  }

  describe('验收 24：用 scripts/seed 合成数据走完整个流程，输出里搜不到敏感内容', () => {
    it('上传 → 识别（含失败和重试）→ 核对 → 解读 → 提纲 → 多步计划 → 确认和复制', async () => {
      // scripts/seed 的合成协会、健管师和客户（带合成姓名）
      const demo = generateDemoData({ today: new Date('2026-10-15T00:00:00Z') });
      await writeDemoData(owner, demo, PASSWORD);
      const demoManager = demo[0]!.org.managers[0]!;
      const demoClient = demoManager.clients[0]!;
      const clientRow = await owner
        .selectFrom('clients')
        .innerJoin('users', 'users.id', 'clients.manager_id')
        .select(['clients.id'])
        .where('users.email', '=', demoManager.email)
        .where('clients.display_name', '=', demoClient.displayName)
        .executeTakeFirstOrThrow();
      const clientId = clientRow.id as string;
      const bareName = demoClient.displayName.replace(/（.*）$/, '');

      // scripts/seed 渲染的合成体检报告 PDF（上面印着合成的姓名、电话、证件号）
      const sample = reportExtractionEvalCases.find((c) => c.id === 'clear-pdf')!.sample;
      const pdf = await renderSamplePdf(sample);
      const fileName = `${demoClient.displayName}-${sample.person.name}-体检报告.pdf`;
      const rows = sample.pages.flat();
      const snippet = (r: (typeof rows)[number]) =>
        `${r.name} ${r.value} ${r.unit ?? ''} 参考 ${r.ref ?? ''}`;
      const items: ItemSpec[] = rows.map((r) => ({
        indicator: r.name,
        value: r.value,
        unit: r.unit,
        referenceRange: r.ref,
        snippet: snippet(r),
      }));
      const REPORT_DATE = '2026-10-10';

      const out = captureOutput();
      /** 4xx、5xx 的响应体 */
      const errorBodies: string[] = [];
      /** 识别进度 SSE 的全文 */
      const uploadSse: string[] = [];
      /** 任务 SSE 里的 error 事件 */
      const taskErrors: TaskStreamEvent[] = [];
      const track = async (req: request.Test) => {
        const res = await req;
        if (res.status >= 400) errorBodies.push(res.text);
        if (res.headers['content-type']?.includes('text/event-stream')) {
          taskErrors.push(...parseSse(res.text).filter((e) => e.type === 'error'));
        }
        return res;
      };
      let interpretationCall: GatewayRequest | undefined;
      let outlineCall: GatewayRequest | undefined;
      try {
        const agent = request.agent(app.getHttpServer());
        await agent
          .post('/api/auth/login')
          .send({ email: demoManager.email, password: PASSWORD })
          .expect(200);
        const taskId = await newTask(agent, clientId);

        // 第一次识别：厂商出错，错误消息里带着姓名、原文和提示词
        provider.push('report_extraction', {
          error: new Error(
            `provider exploded on ${demoClient.displayName} ${snippet(rows[2]!)} ${REPORT_EXTRACTION_PROMPT.slice(0, 40)}`,
          ),
        });
        const created = await track(
          agent
            .post(`/api/clients/${clientId}/report-uploads`)
            .field('taskId', taskId)
            .attach('files', pdf, { filename: fileName, contentType: 'application/pdf' }),
        );
        expect(created.status).toBe(201);
        const uploadId = created.body.upload.id as string;
        await queue.idle();
        uploadSse.push((await agent.get(`/api/report-uploads/${uploadId}/events`)).text);
        // 识别失败：SSE 只推状态和失败类别
        expect(parseSse<ReportUploadStreamEvent>(uploadSse[0]!).at(-1)).toMatchObject({
          type: 'done',
          upload: { status: 'failed', failureCategory: 'error' },
        });

        // 重新识别成功
        provider.push('report_extraction', { text: pageJson(items, { reportDate: REPORT_DATE }) });
        expect((await track(agent.post(`/api/report-uploads/${uploadId}/retry`))).status).toBe(200);
        await queue.idle();
        uploadSse.push((await agent.get(`/api/report-uploads/${uploadId}/events`)).text);
        let u = (await agent.get(`/api/report-uploads/${uploadId}`).expect(200)).body
          .upload as ReportUpload;
        expect(u.status).toBe('needs_review');
        expect(u.values).toHaveLength(rows.length);

        // 核对：改一项、补录一项、一次被拒绝的确认、再确认
        const tc = u.values.find((v) => v.rawName === '总胆固醇')!;
        expect(
          (
            await track(
              agent
                .patch(`/api/report-uploads/${uploadId}/values/${tc.id}`)
                .send({ rawValue: '5.63' }),
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await track(
              agent
                .post(`/api/report-uploads/${uploadId}/values`)
                .send({ rawName: '同型半胱氨酸', rawValue: '11.27', rawUnit: 'μmol/L' }),
            )
          ).status,
        ).toBe(201);
        u = (await agent.get(`/api/report-uploads/${uploadId}`)).body.upload as ReportUpload;
        const rejected = await track(
          agent
            .post(`/api/report-uploads/${uploadId}/verify`)
            .send({ ...verifyBody(u, REPORT_DATE), checkedValueIds: [] }),
        );
        expect(rejected.status).toBe(409);
        for (const v of u.values.filter((x) => x.attention)) {
          await agent
            .patch(`/api/report-uploads/${uploadId}/values/${v.id}`)
            .send({ checked: true })
            .expect(200);
        }
        u = (await agent.get(`/api/report-uploads/${uploadId}`)).body.upload as ReportUpload;
        const verified = await track(
          agent.post(`/api/report-uploads/${uploadId}/verify`).send(verifyBody(u, REPORT_DATE)),
        );
        expect(verified.status).toBe(200);
        const reportId = verified.body.upload.reportId as string;
        await agent.get(`/api/report-files/${u.files[0]!.id}/content`).expect(200);
        const report = (await agent.get(`/api/reports/${reportId}`).expect(200)).body.report;
        const tcIndicator = report.indicators.find((i: { code: string | null }) => i.code === 'tc');
        await agent
          .post(`/api/reports/${reportId}/indicators/${tcIndicator.id}/correct`)
          .send({ rawValue: '5.64' })
          .expect(200);

        // 别人的报告、不存在的报告：错误响应里不带任何资料
        await track(
          agent.post(`/api/tasks/${taskId}/messages`).send({
            mode: 'craft',
            content: `帮${bareName}解读`,
            skillId: 'report-interpretation',
            reportRefs: [randomUUID()],
          }),
        );

        // /体检解读：第一次厂商出错（错误里带着提示词和客户资料），SSE 只推错误类别
        provider.push(
          'report_interpretation',
          {
            error: new Error(
              `provider exploded: ${reportInterpretation.prompt.slice(0, 40)} ${demoClient.displayName} 5.64`,
            ),
          },
          { text: interpretationJson('5.64') },
        );
        const interpretBody = {
          mode: 'craft',
          content: `帮${bareName}解读一下这份报告`,
          skillId: 'report-interpretation',
          reportRefs: [reportId],
        };
        const failed = await track(agent.post(`/api/tasks/${taskId}/messages`).send(interpretBody));
        expect(failed.status).toBe(200);
        expect(parseSse(failed.text).at(-1)).toMatchObject({ type: 'done', reason: 'error' });
        const ok = await track(agent.post(`/api/tasks/${taskId}/messages`).send(interpretBody));
        expect(parseSse(ok.text).some((e) => e.type === 'artifact')).toBe(true);
        interpretationCall = provider.calls
          .filter((c) => c.route === 'report_interpretation')
          .at(-1);

        // /面谈提纲
        provider.push('skill', { text: outlineJson() });
        const outline = await track(
          agent.post(`/api/tasks/${taskId}/messages`).send({
            mode: 'craft',
            content: '列一份面谈提纲',
            skillId: 'interview-outline',
            reportRefs: [reportId],
          }),
        );
        expect(parseSse(outline.text).some((e) => e.type === 'artifact')).toBe(true);
        outlineCall = provider.calls.filter((c) => c.route === 'skill').at(-1);

        // 想一想“新客户完整评估”：先出计划，确认后依次生成解读和提纲
        const proposed = await track(
          agent.post(`/api/tasks/${taskId}/messages`).send({
            mode: 'plan',
            content: '新客户，帮我做个完整评估',
            skillId: 'new-client-assessment',
          }),
        );
        const plan = parseSse(proposed.text).find((e) => e.type === 'plan');
        const planId = plan?.type === 'plan' ? plan.plan.id : '';
        provider.push('report_interpretation', { text: interpretationJson('5.64') });
        provider.push('skill', { text: outlineJson() });
        const confirmed = await track(agent.post(`/api/tasks/${taskId}/plans/${planId}/confirm`));
        expect(parseSse(confirmed.text).filter((e) => e.type === 'artifact')).toHaveLength(2);

        // 确认解读并采用建议分层，复制通俗版；提纲复制被拒绝
        const artifacts = await owner
          .selectFrom('artifacts')
          .select(['id', 'skill_id'])
          .where('task_id', '=', taskId)
          .orderBy('created_at')
          .execute();
        const interp = artifacts.find((a) => a.skill_id === 'report-interpretation')!;
        const d = (await agent.get(`/api/artifacts/${interp.id}`).expect(200)).body;
        expect(
          (
            await track(
              agent.post(`/api/artifacts/${interp.id}/approve`).send({
                version: d.artifact.version,
                contentHash: d.artifact.contentHash,
                adoptRiskTier: true,
              }),
            )
          ).status,
        ).toBe(200);
        await agent.post(`/api/artifacts/${interp.id}/copy`).expect(200);
        const outlineArtifact = artifacts.find((a) => a.skill_id === 'interview-outline')!;
        expect((await track(agent.post(`/api/artifacts/${outlineArtifact.id}/copy`))).status).toBe(
          409,
        );
      } finally {
        out.restore();
      }

      // 埋点：大模型计量、识别和产物的操作记录、每日识别页数
      const analytics = JSON.stringify({
        usage: await owner.selectFrom('llm_usage').selectAll().execute(),
        reportEvents: await owner.selectFrom('report_events').selectAll().execute(),
        artifactEvents: await owner.selectFrom('artifact_events').selectAll().execute(),
        quota: await owner.selectFrom('report_extraction_quota').selectAll().execute(),
      });
      // 计量只有用途、厂商、型号、token、费用、耗时和结果，不带客户 id 和文件信息
      const usage = await owner.selectFrom('llm_usage').selectAll().execute();
      expect(usage.length).toBeGreaterThanOrEqual(6);
      expect(new Set(usage.map((r) => r.route))).toEqual(
        new Set(['report_extraction', 'report_interpretation', 'skill']),
      );
      for (const r of usage) {
        expect(Object.keys(r).sort()).toEqual(
          [
            'cost_usd',
            'created_at',
            'duration_ms',
            'error_type',
            'id',
            'input_tokens',
            'model',
            'operator_id',
            'outcome',
            'output_tokens',
            'provider',
            'route',
            'user_id',
          ].sort(),
        );
      }

      const jobParams = JSON.stringify(queue.jobs.map((j) => j.data));
      expect(jobParams).toMatch(
        /^\[\{"uploadId":"[0-9a-f-]{36}","attempt":[1-3]\}(,\{"uploadId":"[0-9a-f-]{36}","attempt":[1-3]\})*\]$/,
      );
      // SSE 的 error 事件只有错误类别
      expect(taskErrors.length).toBeGreaterThan(0);
      for (const e of taskErrors) expect(Object.keys(e).sort()).toEqual(['kind', 'type']);

      const logs = out.text();
      // 确认确实捕获到了这条流程的日志
      expect(logs).toContain('report extraction');
      expect(logs).toContain('artifact drafted');

      const userMessage = String(interpretationCall?.messages[0]?.content ?? '');
      expect(userMessage).toContain('5.64');
      const outlineMessage = String(outlineCall?.messages[0]?.content ?? '');
      expect(outlineMessage).toContain('5.64');
      const extractionSystem = provider.calls.find((c) => c.route === 'report_extraction')?.system;
      // 发给模型的提示词（系统提示词和组装好的客户资料），每段都均匀取几处来搜
      const prompts = [
        extractionSystem ?? REPORT_EXTRACTION_PROMPT,
        interpretationCall?.system ?? '',
        outlineCall?.system ?? '',
        userMessage,
        outlineMessage,
      ];
      for (const prompt of prompts) expect(prompt.length).toBeGreaterThan(100);
      const forbidden = [
        // 客户姓名（合成）、报告上印的合成个人信息、文件原名
        demoClient.displayName,
        bareName,
        sample.person.name,
        sample.person.phone,
        sample.person.idNumber,
        fileName,
        sample.institution,
        // 指标数值和原文片段（核对时改过、补录、更正的也算）
        ...rows.filter((r) => /\.\d{2}$/.test(r.value)).map((r) => r.value),
        // 一位小数和整数的数值单独搜容易误中，带上单位搜
        ...rows.filter((r) => r.unit).map((r) => `${r.value} ${r.unit}`),
        '5.63',
        '5.64',
        '11.27',
        '5.64 mmol/L',
        ...rows.map(snippet),
        '同型半胱氨酸',
        // 提示词（系统提示词、组装好的客户资料）和回答原文
        ...prompts.flatMap((p) => slicesOf(p)),
        ...slicesOf(reportInterpretation.prompt),
        ...slicesOf(interviewOutline.prompt),
        '### 这次的体检报告',
        MODEL_OVERVIEW,
        MODEL_CLIENT_TEXT.slice(0, 20),
        MODEL_QUESTION,
        MODEL_FINDING,
        MODEL_TIER_REASON,
        MODEL_WHY,
        'provider exploded',
      ];
      const sinks: [string, string][] = [
        ['logs', logs],
        ['error responses', errorBodies.join('\n')],
        ['upload SSE', uploadSse.join('\n')],
        ['task SSE errors', JSON.stringify(taskErrors)],
        ['queue job params', jobParams],
        ['analytics', analytics],
      ];
      expect(errorBodies.length).toBeGreaterThanOrEqual(3);
      for (const [name, text] of sinks) {
        for (const term of forbidden) {
          expect(term.length, 'forbidden term should be non-trivial').toBeGreaterThan(2);
          expect(text.includes(term), `${name} contains ${term}`).toBe(false);
        }
      }
    });
  });

  describe('验收 18、19：第三节接口表逐行的跨租户拒绝', () => {
    /** A1 名下的一整套数据：健康史、分层、待核对和已核对的识别记录、报告、解读草稿 */
    async function setupA1() {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const c = f.clients.a1[0];
      const historyId = (
        await a1
          .post(`/api/clients/${c}/health-history`)
          .send({ category: 'lifestyle', content: '合成记录：每周快走三次' })
          .expect(201)
      ).body.item.id as string;
      await a1
        .post(`/api/clients/${c}/risk-tiers`)
        .send({ tier: 'medium', reason: '合成理由' })
        .expect(201);
      const pending = await extracted(a1, c, [
        { indicator: '总胆固醇', value: '5.62', unit: 'mmol/L', referenceRange: '<5.2' },
      ]);
      const done = await extracted(
        a1,
        c,
        [{ indicator: '空腹血糖', value: '6.5', unit: 'mmol/L', referenceRange: '3.9-6.1' }],
        '2026-09-12',
      );
      const verified = (
        await a1
          .post(`/api/report-uploads/${done.id}/verify`)
          .send(verifyBody(done, '2026-09-12'))
          .expect(200)
      ).body.upload as ReportUpload;
      const reportId = verified.reportId!;
      const report = (await a1.get(`/api/reports/${reportId}`).expect(200)).body.report;
      const taskId = await newTask(a1, c);
      provider.push('report_interpretation', { text: interpretationJson('6.5') });
      await a1
        .post(`/api/tasks/${taskId}/messages`)
        .send({
          mode: 'craft',
          content: '帮我解读',
          skillId: 'report-interpretation',
          reportRefs: [reportId],
        })
        .expect(200);
      const artifactRow = await owner
        .selectFrom('artifacts')
        .select('id')
        .where('task_id', '=', taskId)
        .executeTakeFirstOrThrow();
      const artifact = (await a1.get(`/api/artifacts/${artifactRow.id}`).expect(200)).body
        .artifact as { id: string; version: number; contentHash: string };
      // 想一想：A1 的一份待确认的“新客户完整评估”计划
      const proposed = await a1
        .post(`/api/tasks/${taskId}/messages`)
        .send({ mode: 'plan', content: '完整评估', skillId: 'new-client-assessment' })
        .expect(200);
      const plan = parseSse(proposed.text).find((e) => e.type === 'plan');
      const planId = plan?.type === 'plan' ? plan.plan.id : '';
      expect(planId).not.toBe('');
      return {
        planId,
        c,
        historyId,
        pending,
        verified,
        reportId,
        indicatorId: report.indicators[0].id as string,
        fileId: pending.files[0]!.id,
        valueId: pending.values[0]!.id,
        taskId,
        artifact,
      };
    }
    type A1Data = Awaited<ReturnType<typeof setupA1>>;

    /** 规格 3.4 接口表，一行一项；readable 表示本机构管理员可以只读 */
    function endpointTable(other: Agent, d: A1Data, ownTask: string | null) {
      const rows: { row: string; readable?: boolean; call: () => request.Test }[] = [
        {
          row: 'GET /api/clients/:id/record',
          readable: true,
          call: () => other.get(`/api/clients/${d.c}/record`),
        },
        {
          row: 'PATCH /api/clients/:id',
          call: () => other.patch(`/api/clients/${d.c}`).send({ displayName: '改名' }),
        },
        {
          row: 'GET /api/clients/:id/health-history',
          readable: true,
          call: () => other.get(`/api/clients/${d.c}/health-history`),
        },
        {
          row: 'POST /api/clients/:id/health-history',
          call: () =>
            other
              .post(`/api/clients/${d.c}/health-history`)
              .send({ category: 'allergy', content: '合成' }),
        },
        {
          row: 'PATCH /api/clients/:id/health-history/:itemId',
          call: () =>
            other
              .patch(`/api/clients/${d.c}/health-history/${d.historyId}`)
              .send({ content: '改掉' }),
        },
        {
          row: 'DELETE /api/clients/:id/health-history/:itemId',
          call: () => other.delete(`/api/clients/${d.c}/health-history/${d.historyId}`),
        },
        {
          row: 'POST /api/clients/:id/report-uploads',
          call: () =>
            other
              .post(`/api/clients/${d.c}/report-uploads`)
              .attach('files', syntheticPng(), { filename: 'a.png', contentType: 'image/png' }),
        },
        {
          row: 'GET /api/clients/:id/report-uploads',
          call: () => other.get(`/api/clients/${d.c}/report-uploads`),
        },
        {
          row: 'GET /api/report-uploads/:id',
          call: () => other.get(`/api/report-uploads/${d.pending.id}`),
        },
        {
          row: 'GET /api/report-uploads/:id/events',
          call: () => other.get(`/api/report-uploads/${d.pending.id}/events`),
        },
        {
          row: 'POST /api/report-uploads/:id/retry',
          call: () => other.post(`/api/report-uploads/${d.pending.id}/retry`),
        },
        {
          row: 'POST /api/report-uploads/:id/discard',
          call: () => other.post(`/api/report-uploads/${d.pending.id}/discard`),
        },
        {
          row: 'PATCH /api/report-uploads/:id/values/:valueId',
          call: () =>
            other
              .patch(`/api/report-uploads/${d.pending.id}/values/${d.valueId}`)
              .send({ checked: true }),
        },
        {
          row: 'POST /api/report-uploads/:id/values',
          call: () =>
            other
              .post(`/api/report-uploads/${d.pending.id}/values`)
              .send({ rawName: '收缩压', rawValue: '120', rawUnit: 'mmHg' }),
        },
        {
          row: 'POST /api/report-uploads/:id/verify',
          call: () =>
            other
              .post(`/api/report-uploads/${d.pending.id}/verify`)
              .send(verifyBody(d.pending, '2026-05-01')),
        },
        {
          row: 'GET /api/report-files/:id/content',
          call: () => other.get(`/api/report-files/${d.fileId}/content`),
        },
        {
          row: 'GET /api/clients/:id/reports',
          readable: true,
          call: () => other.get(`/api/clients/${d.c}/reports`),
        },
        {
          row: 'GET /api/reports/:id',
          readable: true,
          call: () => other.get(`/api/reports/${d.reportId}`),
        },
        {
          row: 'POST /api/reports/:id/indicators/:indicatorId/correct',
          call: () =>
            other
              .post(`/api/reports/${d.reportId}/indicators/${d.indicatorId}/correct`)
              .send({ rawValue: '5.0' }),
        },
        {
          row: 'GET /api/clients/:id/indicators/:code/trend',
          readable: true,
          call: () => other.get(`/api/clients/${d.c}/indicators/fpg/trend`),
        },
        {
          row: 'GET /api/clients/:id/risk-tiers',
          readable: true,
          call: () => other.get(`/api/clients/${d.c}/risk-tiers`),
        },
        {
          row: 'POST /api/clients/:id/risk-tiers',
          call: () =>
            other.post(`/api/clients/${d.c}/risk-tiers`).send({ tier: 'high', reason: '合成' }),
        },
        // reportRefs 指向 A1 的报告：自己的任务（如有）或 A1 的任务
        {
          row: 'POST /api/tasks/:id/messages (reportRefs)',
          call: () =>
            other.post(`/api/tasks/${ownTask ?? d.taskId}/messages`).send({
              mode: 'craft',
              content: '解读',
              skillId: 'report-interpretation',
              reportRefs: [d.reportId],
            }),
        },
        {
          row: 'POST /api/tasks/:id/plans/:planId/confirm',
          call: () => other.post(`/api/tasks/${d.taskId}/plans/${d.planId}/confirm`),
        },
        {
          row: 'POST /api/artifacts/:id/approve (adoptRiskTier)',
          call: () =>
            other.post(`/api/artifacts/${d.artifact.id}/approve`).send({
              version: d.artifact.version,
              contentHash: d.artifact.contentHash,
              adoptRiskTier: true,
            }),
        },
      ];
      return rows;
    }

    const snapshotCounts = async () => {
      const out: Record<string, number> = {};
      for (const t of [
        'client_health_history',
        'client_risk_tiers',
        'report_uploads',
        'report_files',
        'extracted_values',
        'health_reports',
        'report_indicators',
        'artifacts',
        'artifact_events',
      ]) {
        out[t] = Number(
          (await sql<{ n: string }>`select count(*) as n from ${sql.table(t)}`.execute(owner))
            .rows[0]?.n,
        );
      }
      // 别的健管师在自己任务里发的消息不算；A1 任务里的消息和计划状态不能变
      out.a1_task_messages = Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from task_messages m join tasks t on t.id = m.task_id where t.manager_id = ${f.users.managerA1.id}`.execute(
            owner,
          )
        ).rows[0]?.n,
      );
      out.a1_plans_not_proposed = Number(
        (
          await sql<{
            n: string;
          }>`select count(*) as n from task_plans where manager_id = ${f.users.managerA1.id} and status <> 'proposed'`.execute(
            owner,
          )
        ).rows[0]?.n,
      );
      return out;
    };

    it('协会 B、同协会其他健管师、同协会别的机构、运营商、平台、别的机构管理员：每一行都是 404，什么都没被改', async () => {
      const d = await setupA1();
      const before = await snapshotCounts();
      const objects = storage.objects.size;
      const pendingVersion = d.pending.version;
      const ownClient: Record<string, string> = {
        [f.users.managerA2.email]: f.clients.a2,
        [f.users.managerA3.email]: f.clients.a3,
        [f.users.managerB1.email]: f.clients.b1,
      };
      const accounts: Account[] = [
        f.users.managerA2,
        f.users.managerA3,
        f.users.managerB1,
        f.users.operatorAdminA,
        f.users.operatorAdminB,
        f.users.platform,
        f.users.orgAdminA2,
      ];
      const covered = new Set<string>();
      for (const account of accounts) {
        const other = await loginAs(app, account.email);
        const own = ownClient[account.email];
        const ownTask = own ? await newTask(other, own) : null;
        provider.reset();
        for (const { row, call } of endpointTable(other, d, ownTask)) {
          const res = await call();
          expect(res.status, `${account.email} ${row}`).toBe(404);
          expect(res.body, `${account.email} ${row}`).toEqual({ error: 'not_found' });
          covered.add(row);
        }
        // 没有调用模型
        expect(provider.calls, account.email).toEqual([]);
      }
      // 表里每一行都测到了（POST /api/clients 单独测）
      expect(covered.size).toBe(25);
      expect(await snapshotCounts()).toEqual(before);
      expect(storage.objects.size).toBe(objects);
      const a1 = await loginAs(app, f.users.managerA1.email);
      const pending = (await a1.get(`/api/report-uploads/${d.pending.id}`)).body.upload;
      expect(pending).toMatchObject({ status: 'needs_review', version: pendingVersion });
      const tiers = (await a1.get(`/api/clients/${d.c}/risk-tiers`)).body;
      expect(JSON.stringify(tiers)).not.toContain('"high"');
    });

    it('Q14：本机构管理员只读档案、健康史、报告、趋势、分层历史，读不到原件和待核对数据，写一律 404', async () => {
      const d = await setupA1();
      const before = await snapshotCounts();
      const admin = await loginAs(app, f.users.orgAdminA.email);
      for (const { row, readable, call } of endpointTable(admin, d, null)) {
        const res = await call();
        expect(res.status, row).toBe(readable ? 200 : 404);
      }
      const record = (await admin.get(`/api/clients/${d.c}/record`).expect(200)).body;
      const recordText = JSON.stringify(record);
      expect(recordText).not.toContain(d.pending.id);
      expect(recordText).not.toContain(d.fileId);
      expect(recordText).not.toContain(d.artifact.id);
      const report = (await admin.get(`/api/reports/${d.reportId}`).expect(200)).body.report;
      expect(report.files).toEqual([]);
      expect(await snapshotCounts()).toEqual(before);
    });

    it('POST /api/clients：请求体里的租户字段（驼峰和下划线）被忽略，只建在自己名下；非健管师 403', async () => {
      const b1 = await loginAs(app, f.users.managerB1.email);
      for (const injected of [
        { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id },
        { operator_id: f.operatorA, org_id: f.orgA, manager_id: f.users.managerA1.id },
        {
          operatorId: f.operatorA,
          org_id: f.orgA2,
          managerId: f.users.managerA3.id,
          manager_id: f.users.managerA1.id,
        },
      ]) {
        const res = await b1
          .post('/api/clients')
          .send({ displayName: '合成新客户', ...injected })
          .expect(201);
        const row = await owner
          .selectFrom('clients')
          .select(['operator_id', 'org_id', 'manager_id'])
          .where('id', '=', res.body.client.id)
          .executeTakeFirstOrThrow();
        expect(row, JSON.stringify(Object.keys(injected))).toEqual({
          operator_id: f.operatorB,
          org_id: f.orgB,
          manager_id: f.users.managerB1.id,
        });
      }
      // 规格 3.4：非健管师角色按角色拒绝，返回 403
      for (const account of [
        f.users.orgAdminA,
        f.users.orgAdminA2,
        f.users.operatorAdminA,
        f.users.operatorAdminB,
        f.users.platform,
      ]) {
        const other = await loginAs(app, account.email);
        const denied = await other.post('/api/clients').send({
          displayName: '合成客户丁',
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
        });
        expect(denied.status, account.email).toBe(403);
        expect(denied.body, account.email).toEqual({ error: 'forbidden' });
      }
      expect(
        await owner
          .selectFrom('clients')
          .select('id')
          .where('display_name', '=', '合成客户丁')
          .execute(),
      ).toEqual([]);
    });
  });

  describe('混用 id：路径里是自己的资源，子资源 id 是别人的', () => {
    it('B1 自己的识别记录 + A1 的识别结果 id、B1 自己的报告 + A1 的指标 id：都是 404，两边数据都不变', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const b1 = await loginAs(app, f.users.managerB1.email);
      const item = { indicator: '总胆固醇', value: '5.62', unit: 'mmol/L', referenceRange: '<5.2' };
      const a1Pending = await extracted(a1, f.clients.a1[0], [item]);
      const a1Done = await extracted(a1, f.clients.a1[0], [item], '2026-09-12');
      const a1Report = (
        await a1
          .post(`/api/report-uploads/${a1Done.id}/verify`)
          .send(verifyBody(a1Done, '2026-09-12'))
          .expect(200)
      ).body.upload.reportId as string;
      const b1Pending = await extracted(b1, f.clients.b1, [item]);
      const b1Done = await extracted(b1, f.clients.b1, [item], '2026-09-12');
      const b1Report = (
        await b1
          .post(`/api/report-uploads/${b1Done.id}/verify`)
          .send(verifyBody(b1Done, '2026-09-12'))
          .expect(200)
      ).body.upload.reportId as string;
      const a1Indicator = (await a1.get(`/api/reports/${a1Report}`).expect(200)).body.report
        .indicators[0].id as string;
      const indicatorsBefore = await owner
        .selectFrom('report_indicators')
        .select(['id', 'value', 'superseded_by'])
        .orderBy('id')
        .execute();

      for (const body of [{ checked: true }, { rawValue: '9.99' }]) {
        const res = await b1
          .patch(`/api/report-uploads/${b1Pending.id}/values/${a1Pending.values[0]!.id}`)
          .send(body);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'not_found' });
      }
      const corrected = await b1
        .post(`/api/reports/${b1Report}/indicators/${a1Indicator}/correct`)
        .send({ rawValue: '9.99' });
      expect(corrected.status).toBe(404);
      expect(corrected.body).toEqual({ error: 'not_found' });

      const a1After = (await a1.get(`/api/report-uploads/${a1Pending.id}`)).body
        .upload as ReportUpload;
      expect(a1After.version).toBe(a1Pending.version);
      expect(a1After.values).toEqual(a1Pending.values);
      const b1After = (await b1.get(`/api/report-uploads/${b1Pending.id}`)).body
        .upload as ReportUpload;
      expect(b1After.version).toBe(b1Pending.version);
      expect(
        await owner
          .selectFrom('report_indicators')
          .select(['id', 'value', 'superseded_by'])
          .orderBy('id')
          .execute(),
      ).toEqual(indicatorsBefore);
    });
  });

  describe('验收 20：以应用角色直接查库，逐表检查行级安全', () => {
    const TABLES = [
      'client_health_history',
      'client_risk_tiers',
      'report_uploads',
      'report_files',
      'extracted_values',
      'report_events',
      'report_extraction_quota',
      'health_reports',
      'report_indicators',
      'artifacts',
    ] as const;
    let appDb: Kysely<Database>;

    beforeAll(() => {
      appDb = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
        }),
      });
    });
    afterAll(async () => {
      await appDb.destroy();
    });

    it('A1 的数据在每张新表、扩展表里都有；没有上下文、其他健管师和管理员上下文下都查不到', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const c = f.clients.a1[0];
      await a1
        .post(`/api/clients/${c}/health-history`)
        .send({ category: 'allergy', content: '合成记录' })
        .expect(201);
      await a1
        .post(`/api/clients/${c}/risk-tiers`)
        .send({ tier: 'low', reason: '合成' })
        .expect(201);
      const done = await extracted(a1, c, [
        { indicator: '空腹血糖', value: '6.5', unit: 'mmol/L', referenceRange: '3.9-6.1' },
      ]);
      const verified = (
        await a1
          .post(`/api/report-uploads/${done.id}/verify`)
          .send(verifyBody(done, '2026-05-01'))
          .expect(200)
      ).body.upload as ReportUpload;
      const taskId = await newTask(a1, c);
      provider.push('report_interpretation', { text: interpretationJson('6.5') });
      await a1
        .post(`/api/tasks/${taskId}/messages`)
        .send({
          mode: 'craft',
          content: '解读',
          skillId: 'report-interpretation',
          reportRefs: [verified.reportId],
        })
        .expect(200);

      /** 每张表里属于 A1 这位客户（或 A1 本人）的行数 */
      const countA1 = async (db: QueryExecutorProvider, table: (typeof TABLES)[number]) => {
        const q =
          table === 'report_extraction_quota'
            ? sql<{
                n: string;
              }>`select count(*) as n from report_extraction_quota where manager_id = ${f.users.managerA1.id}`
            : table === 'artifacts'
              ? sql<{
                  n: string;
                }>`select count(*) as n from artifacts where client_id = ${c} and source_report_id is not null`
              : sql<{
                  n: string;
                }>`select count(*) as n from ${sql.table(table)} where client_id = ${c}`;
        return Number((await q.execute(db)).rows[0]?.n);
      };
      const ctx = (
        a: Account,
        role: TenantContext['role'],
        operatorId: string | null,
        orgId: string | null,
      ): TenantContext => ({
        userId: a.id,
        role,
        operatorId,
        orgId,
      });

      // 所有者能看到：每张表都确实有 A1 的数据，下面的“查不到”才有意义
      for (const t of TABLES) expect(await countA1(owner, t), `owner ${t}`).toBeGreaterThan(0);
      // A1 自己的上下文能看到
      await withTenant(
        appDb,
        ctx(f.users.managerA1, 'manager', f.operatorA, f.orgA),
        async (trx) => {
          for (const t of TABLES) expect(await countA1(trx, t), `A1 ${t}`).toBeGreaterThan(0);
        },
      );
      // 没有上下文
      for (const t of TABLES) expect(await countA1(appDb, t), `no context ${t}`).toBe(0);
      // 原件清除队列：应用角色无论有没有上下文都不能直接读，只有系统函数能用
      await expect(sql`select * from storage_purge_queue`.execute(appDb)).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        withTenant(appDb, ctx(f.users.managerA1, 'manager', f.operatorA, f.orgA), (trx) =>
          sql`select * from storage_purge_queue`.execute(trx),
        ),
      ).rejects.toThrow(/permission denied/);
      // 其他健管师、运营商和平台管理员、别的机构管理员
      for (const other of [
        ctx(f.users.managerA2, 'manager', f.operatorA, f.orgA),
        ctx(f.users.managerA3, 'manager', f.operatorA, f.orgA2),
        ctx(f.users.managerB1, 'manager', f.operatorB, f.orgB),
        ctx(f.users.operatorAdminA, 'operator_admin', f.operatorA, null),
        ctx(f.users.platform, 'platform_admin', null, null),
        ctx(f.users.orgAdminA2, 'org_admin', f.operatorA, f.orgA2),
      ]) {
        await withTenant(appDb, other, async (trx) => {
          for (const t of TABLES)
            expect(await countA1(trx, t), `${other.role} ${other.userId} ${t}`).toBe(0);
        });
      }
      // Q14：本机构管理员只能读已核对的报告、指标、健康史和分层，读不到识别过程、原件、产物和页数
      await withTenant(
        appDb,
        ctx(f.users.orgAdminA, 'org_admin', f.operatorA, f.orgA),
        async (trx) => {
          const readable = new Set([
            'client_health_history',
            'client_risk_tiers',
            'health_reports',
            'report_indicators',
          ]);
          for (const t of TABLES) {
            const n = await countA1(trx, t);
            if (readable.has(t)) expect(n, `org admin ${t}`).toBeGreaterThan(0);
            else expect(n, `org admin ${t}`).toBe(0);
          }
        },
      );
    });
  });

  describe('验收 22：构造的队列任务读不到数据', () => {
    it('upload_id 属于别人已核对的、次数对不上的、不存在的：不调模型、不读原件、不写识别结果', async () => {
      const b1 = await loginAs(app, f.users.managerB1.email);
      const b1Verified = await extracted(b1, f.clients.b1, [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
      ]);
      await b1
        .post(`/api/report-uploads/${b1Verified.id}/verify`)
        .send(verifyBody(b1Verified, '2026-05-01'))
        .expect(200);
      // B1 另一份还在排队的识别记录（队列暂停）
      queue.paused = true;
      const queued = await b1
        .post(`/api/clients/${f.clients.b1}/report-uploads`)
        .attach('files', syntheticPng(), { filename: 'b.png', contentType: 'image/png' })
        .expect(201);
      const queuedId = queued.body.upload.id as string;

      provider.reset();
      const get = vi.spyOn(storage, 'get');
      const valuesBefore = await owner.selectFrom('extracted_values').select('id').execute();
      const eventsBefore = await owner.selectFrom('report_events').select('id').execute();
      try {
        for (const job of [
          { uploadId: b1Verified.id, attempt: 1 },
          { uploadId: queuedId, attempt: 2 },
          { uploadId: queuedId, attempt: 0 },
          { uploadId: randomUUID(), attempt: 1 },
        ]) {
          expect(await queue.run(job), JSON.stringify(job)).toBe('failed');
        }
        expect(get).not.toHaveBeenCalled();
        expect(provider.calls).toEqual([]);
        expect(await owner.selectFrom('extracted_values').select('id').execute()).toEqual(
          valuesBefore,
        );
        expect(await owner.selectFrom('report_events').select('id').execute()).toEqual(
          eventsBefore,
        );
        const row = await owner
          .selectFrom('report_uploads')
          .select(['status', 'attempts'])
          .where('id', '=', queuedId)
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ status: 'queued', attempts: 1 });
      } finally {
        get.mockRestore();
        queue.jobs.length = 0;
        queue.paused = false;
      }
    });

    /** 协会 B 里另一位健管师 B2（只用来把识别记录指到别人名下，不登录） */
    async function insertManagerB2(): Promise<string> {
      const b1Row = await owner
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', f.users.managerB1.id)
        .executeTakeFirstOrThrow();
      const row = await owner
        .insertInto('users')
        .values({
          email: 'manager-b2@test.example',
          password_hash: b1Row.password_hash,
          display_name: '测试 manager-b2',
          role: 'manager',
          operator_id: f.operatorB,
          org_id: f.orgB,
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id as string;
    }

    /** B1 的一份排队中的识别记录（队列暂停，任务不会自己执行） */
    async function queuedB1Upload(): Promise<string> {
      const b1 = await loginAs(app, f.users.managerB1.email);
      queue.paused = true;
      const res = await b1
        .post(`/api/clients/${f.clients.b1}/report-uploads`)
        .attach('files', syntheticPng(), { filename: 'b.png', contentType: 'image/png' })
        .expect(201);
      return res.body.upload.id as string;
    }

    /** 以所有者身份直接改识别记录，绕过触发器和外键（模拟数据被篡改，只在测试里这样做） */
    async function tamper(uploadId: string, set: { manager_id: string; requested_by?: string }) {
      await owner.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await trx.updateTable('report_uploads').set(set).where('id', '=', uploadId).execute();
      });
    }

    it('次数正确、但记录被指到别人名下的任务：在租户检查处失败，不调模型、不读原件、不写结果', async () => {
      const b2 = await insertManagerB2();
      const repo = app.get(ReportsRepository);
      // 情况一：记录的健管师和发起人都改成 B2，客户仍是 B1 的。
      // 任务以 B2 的身份认领，行级安全放行了记录本身，但客户不归 B2，认领失败
      const a = await queuedB1Upload();
      await tamper(a, { manager_id: b2, requested_by: b2 });
      // 情况二：只把记录的健管师改成 B2，发起人仍是 B1：查不到发起人
      const b = await queuedB1Upload();
      await tamper(b, { manager_id: b2 });

      provider.reset();
      const get = vi.spyOn(storage, 'get');
      const claim = vi.spyOn(repo, 'claimExtraction');
      const requester = vi.spyOn(repo, 'requester');
      const valuesBefore = await owner.selectFrom('extracted_values').select('id').execute();
      const eventsBefore = await owner.selectFrom('report_events').select('id').execute();
      try {
        expect(await queue.run({ uploadId: a, attempt: 1 })).toBe('failed');
        // 确实走到了认领（租户检查），用的是记录上发起人 B2 的上下文，认领没有成功
        expect(claim).toHaveBeenCalledTimes(1);
        expect(claim.mock.calls[0]![0]).toEqual({
          userId: b2,
          role: 'manager',
          operatorId: f.operatorB,
          orgId: f.orgB,
        });
        expect(await claim.mock.results[0]!.value).toBeUndefined();

        expect(await queue.run({ uploadId: b, attempt: 1 })).toBe('failed');
        // 情况二在查发起人这一步就失败：查了 b，没有查到，也没有去认领
        expect(requester).toHaveBeenLastCalledWith(b);
        expect(await requester.mock.results.at(-1)!.value).toBeUndefined();
        expect(claim).toHaveBeenCalledTimes(1);

        expect(get).not.toHaveBeenCalled();
        expect(provider.calls).toEqual([]);
        expect(await owner.selectFrom('extracted_values').select('id').execute()).toEqual(
          valuesBefore,
        );
        expect(await owner.selectFrom('report_events').select('id').execute()).toEqual(
          eventsBefore,
        );
        const rows = await owner
          .selectFrom('report_uploads')
          .select(['id', 'status', 'progress_page'])
          .where('id', 'in', [a, b])
          .execute();
        for (const r of rows) expect(r).toMatchObject({ status: 'queued', progress_page: 0 });
      } finally {
        get.mockRestore();
        claim.mockRestore();
        requester.mockRestore();
        queue.jobs.length = 0;
        queue.paused = false;
      }
    });

    it('正常的任务：用上传者 B1 的身份（userId、operatorId、orgId）认领和识别', async () => {
      const repo = app.get(ReportsRepository);
      const requester = vi.spyOn(repo, 'requester');
      const claim = vi.spyOn(repo, 'claimExtraction');
      try {
        const b1 = await loginAs(app, f.users.managerB1.email);
        const u = await extracted(b1, f.clients.b1, [
          { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
        ]);
        expect(u.status).toBe('needs_review');
        const uploader = {
          userId: f.users.managerB1.id,
          role: 'manager',
          operatorId: f.operatorB,
          orgId: f.orgB,
        };
        expect(requester).toHaveBeenCalledWith(u.id);
        expect(await requester.mock.results[0]!.value).toEqual(uploader);
        expect(claim).toHaveBeenCalledWith(uploader, u.id, 1);
      } finally {
        requester.mockRestore();
        claim.mockRestore();
      }
    });
  });
});
