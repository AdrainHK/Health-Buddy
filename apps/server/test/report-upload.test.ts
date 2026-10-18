import { randomUUID } from 'node:crypto';
import { CODED_PANEL, REPORT_EXTRACTION_PROMPT } from '@health-buddy/skills';
import type { ReportUpload, ReportUploadStreamEvent } from '@health-buddy/shared';
import { Logger, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineExtractionQueue } from '../src/reports/extraction-queue.js';
import { ReportsRepository } from '../src/reports/reports.repository.js';
import { WorkbenchRepository } from '../src/workbench/workbench.repository.js';
import { InMemoryObjectStorage } from '../src/reports/storage.js';
import { TWIN_QUEUE, type InProcessTwinQueue } from '../src/twin/twin-queue.js';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import {
  ExtractionProvider,
  pageJson,
  renamedExe,
  syntheticPdf,
  syntheticPng,
  type ItemSpec,
} from './report-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 识别结果里用的合成数值和原文，日志检查时搜这些 */
const FPG_RAW = '108.7';
const FPG_SNIPPET = '空腹血糖 108.7 mg/dL 参考 70-110';
const FILE_NAME = '张小明-合成体检报告.png';

const STANDARD_ITEMS: ItemSpec[] = [
  // mg/dL 的血糖换算成 mmol/L（验收标准 6）
  {
    indicator: '空腹血糖',
    value: FPG_RAW,
    unit: 'mg/dL',
    referenceRange: '70-110',
    snippet: FPG_SNIPPET,
  },
  // 印的是 <5.2：等于 5.2 算偏高（验收标准 10）
  { indicator: '总胆固醇', value: '5.2', unit: 'mmol/L', referenceRange: '<5.2' },
  // 超出合理范围
  { indicator: '体重', value: '650', unit: 'kg' },
  // 未收录指标
  { indicator: '同型半胱氨酸', value: '12', unit: 'μmol/L', referenceRange: '0-15' },
];

function parseSse(text: string): ReportUploadStreamEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as ReportUploadStreamEvent);
}

describe('报告上传、识别和核对接口', () => {
  const owner = ownerDb();
  const provider = new ExtractionProvider();
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
    // 上一个测试留下的识别任务先执行完，再清空数据
    queue.paused = false;
    queue.resume();
    await queue.idle();
    // 核对、更正会排孪生计算任务，清空数据前也等它们执行完
    await app.get<InProcessTwinQueue>(TWIN_QUEUE).idle();
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

  const upload = (
    agent: Agent,
    clientId: string,
    files: { body: Buffer; name?: string; type?: string }[],
    taskId?: string,
  ) => {
    let req = agent.post(`/api/clients/${clientId}/report-uploads`);
    if (taskId) req = req.field('taskId', taskId);
    for (const file of files) {
      req = req.attach('files', file.body, {
        filename: file.name ?? FILE_NAME,
        contentType: file.type ?? 'image/png',
      });
    }
    return req;
  };

  /** 上传一张图片并识别完，返回待核对的识别记录 */
  async function extracted(
    agent: Agent,
    clientId: string,
    items: ItemSpec[] = STANDARD_ITEMS,
    extra: Parameters<typeof pageJson>[1] = {},
  ): Promise<ReportUpload> {
    provider.push(pageJson(items, extra));
    const res = await upload(agent, clientId, [{ body: syntheticPng() }]).expect(201);
    await queue.idle();
    const detail = await agent.get(`/api/report-uploads/${res.body.upload.id}`).expect(200);
    return detail.body.upload as ReportUpload;
  }

  const verify = (agent: Agent, u: ReportUpload, body: Record<string, unknown> = {}) =>
    agent.post(`/api/report-uploads/${u.id}/verify`).send({
      version: u.version,
      checkedValueIds: u.values.filter((v) => v.attention).map((v) => v.id),
      reportDate: '2026-05-01',
      identityConfirmed: true,
      ...body,
    });

  const countRows = async (table: string) =>
    Number(
      (await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(owner))
        .rows[0]?.n,
    );

  describe('上传和识别', () => {
    it('上传一张图片：保存原件、入队只带 upload_id，识别后进入待核对并做换算和标记', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0]);

      expect(u.status).toBe('needs_review');
      expect(u.reportDate).toBe('2026-05-01');
      expect(u.institution).toBe('合成体检中心');
      expect(u.files).toEqual([
        expect.objectContaining({ mimeType: 'image/png', pageCount: 1, originalName: FILE_NAME }),
      ]);
      // 队列任务参数只有 upload_id
      expect(queue.jobs.map((j) => j.data)).toEqual([{ uploadId: u.id, attempt: 1 }]);
      expect(queue.jobs[0]?.outcome).toBe('completed');

      const byName = Object.fromEntries(u.values.map((v) => [v.rawName, v]));
      // 验收标准 6：mg/dL 换算成 mmol/L，原值和原单位保留
      expect(byName['空腹血糖']).toMatchObject({
        code: 'fpg',
        rawValue: FPG_RAW,
        rawUnit: 'mg/dL',
        value: 6.033,
        unit: 'mmol/L',
        flags: ['unit_converted'],
        attention: true,
        page: 1,
        sourceSnippet: FPG_SNIPPET,
      });
      expect(byName['总胆固醇']).toMatchObject({
        code: 'tc',
        value: 5.2,
        flags: [],
        attention: false,
        abnormal: 'high',
      });
      expect(byName['体重']).toMatchObject({ code: 'weight', flags: ['out_of_bounds'] });
      expect(byName['同型半胱氨酸']).toMatchObject({ code: null, flags: ['unmapped'] });

      // 发给模型的是识别提示词和这一页的图片，不带客户姓名
      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0]!;
      expect(call.system).toBe(REPORT_EXTRACTION_PROMPT);
      expect(JSON.stringify(call)).not.toContain('测试客户');
      const content = call.messages[0]?.content;
      expect(Array.isArray(content) && content.map((p) => p.type)).toEqual(['text', 'image']);

      // 存储 key 是随机 id，不含姓名和文件名（验收标准 23）
      const keys = [...storage.objects.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^reports\/[0-9a-f]{32}$/);
    });

    it('多页 PDF 逐页识别，进度按页推进；SSE 只推状态和页数', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      provider.push(
        pageJson([{ indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' }]),
        pageJson([{ indicator: '甘油三酯', value: '1.2', unit: 'mmol/L' }], { reportDate: null }),
        pageJson([], { category: 'not_a_report' }),
      );
      const res = await upload(agent, f.clients.a1[0], [
        { body: await syntheticPdf(3), name: '体检.pdf', type: 'application/pdf' },
      ]).expect(201);
      expect(res.body.upload).toMatchObject({ status: 'queued', pageCount: 3 });
      await queue.idle();
      expect(provider.calls).toHaveLength(3);
      expect(provider.calls.every((c) => JSON.stringify(c.messages).includes('"pdf"'))).toBe(true);

      const sse = await agent.get(`/api/report-uploads/${res.body.upload.id}/events`).expect(200);
      expect(sse.headers['content-type']).toContain('text/event-stream');
      const events = parseSse(sse.text);
      expect(events).toEqual([
        {
          type: 'done',
          upload: expect.objectContaining({ status: 'needs_review', progressPage: 3 }),
        },
      ]);
      const detail = (await agent.get(`/api/report-uploads/${res.body.upload.id}`)).body.upload;
      expect(detail.values.map((v: { code: string; page: number }) => [v.code, v.page])).toEqual([
        ['fpg', 1],
        ['tg', 2],
      ]);
    });

    it('三张照片组成一份报告；粘贴的截图和 JPG 也能上传', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from(randomUUID()),
      ]);
      const res = await upload(agent, f.clients.a1[0], [
        { body: syntheticPng(), name: 'image.png' },
        { body: jpeg, name: 'IMG_0001.HEIC.jpg', type: 'image/jpeg' },
        { body: syntheticPng(), name: 'paste.png' },
      ]).expect(201);
      expect(res.body.upload.pageCount).toBe(3);
      expect(res.body.upload.files.map((x: { mimeType: string }) => x.mimeType)).toEqual([
        'image/png',
        'image/jpeg',
        'image/png',
      ]);
    });

    it('验收标准 9：不是体检报告的图片识别为 not_a_report，不产生任何数值；可以重新识别', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [], { category: 'not_a_report' });
      expect(u).toMatchObject({ status: 'failed', failureCategory: 'not_a_report', values: [] });
      expect(await countRows('extracted_values')).toBe(0);

      provider.push(pageJson([{ indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' }]));
      const retried = await agent.post(`/api/report-uploads/${u.id}/retry`).expect(200);
      expect(retried.body.upload.attempts).toBe(2);
      await queue.idle();
      const after = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload;
      expect(after.status).toBe('needs_review');
      expect(queue.jobs.map((j) => j.attempt)).toEqual([1, 2]);
    });

    it('模型拒绝、出错都以失败结束，最多重新识别 3 次', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      provider.queue.push({ finishReason: 'refused' });
      const res = await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }]).expect(201);
      await queue.idle();
      const id = res.body.upload.id;
      expect((await agent.get(`/api/report-uploads/${id}`)).body.upload).toMatchObject({
        status: 'failed',
        failureCategory: 'refused',
      });
      for (const attempt of [2, 3]) {
        provider.queue.push({ error: new Error('upstream exploded') });
        await agent.post(`/api/report-uploads/${id}/retry`).expect(200);
        await queue.idle();
        expect((await agent.get(`/api/report-uploads/${id}`)).body.upload).toMatchObject({
          status: 'failed',
          failureCategory: 'error',
          attempts: attempt,
        });
      }
      const limit = await agent.post(`/api/report-uploads/${id}/retry`).expect(409);
      expect(limit.body.reasons).toEqual(['retry_limit']);
    });

    it('验收标准 8：改名的可执行文件、超大、超页数、超数量都被拒绝，不保存任何东西', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const exe = await upload(agent, f.clients.a1[0], [
        { body: renamedExe(), name: 'report.pdf', type: 'application/pdf' },
      ]).expect(415);
      expect(exe.body).toEqual({ error: 'unsupported_media_type', reasons: ['unsupported_type'] });

      // 文件头是 PNG 但混着一个不支持的文件，整份拒绝
      await upload(agent, f.clients.a1[0], [
        { body: syntheticPng() },
        { body: Buffer.from('PK\x03\x04 fake zip'), name: 'a.zip', type: 'application/zip' },
      ]).expect(415);

      const big = Buffer.concat([syntheticPng(), Buffer.alloc(20 * 1024 * 1024)]);
      const tooBig = await upload(agent, f.clients.a1[0], [{ body: big }]).expect(413);
      expect(tooBig.body.reasons).toEqual(['file_too_large']);

      const pages = await upload(agent, f.clients.a1[0], [
        { body: await syntheticPdf(31), name: 'long.pdf', type: 'application/pdf' },
      ]).expect(413);
      expect(pages.body.reasons).toEqual(['too_many_pages']);

      const pages2 = await upload(agent, f.clients.a1[0], [
        { body: await syntheticPdf(20), name: 'a.pdf', type: 'application/pdf' },
        { body: await syntheticPdf(11), name: 'b.pdf', type: 'application/pdf' },
      ]).expect(413);
      expect(pages2.body.reasons).toEqual(['too_many_pages']);

      const many = await upload(
        agent,
        f.clients.a1[0],
        Array.from({ length: 11 }, () => ({ body: syntheticPng() })),
      ).expect(413);
      expect(many.body.reasons).toEqual(['too_many_files']);

      await upload(agent, f.clients.a1[0], []).expect(400);

      expect(storage.objects.size).toBe(0);
      for (const t of ['report_uploads', 'report_files', 'report_events']) {
        expect(await countRows(t), t).toBe(0);
      }
      expect(queue.jobs).toHaveLength(0);
    });

    it('Q17：同一个文件重复上传被拒绝；一次上传里两个相同文件也拒绝；放弃后可以再传', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const file = syntheticPng();
      const first = await upload(agent, f.clients.a1[0], [{ body: file }]).expect(201);
      await queue.idle();
      const again = await upload(agent, f.clients.a1[0], [{ body: file }]).expect(409);
      expect(again.body.reasons).toEqual(['duplicate_file']);
      // 附带已有那一份（验收反馈 6）：只有 id、状态和报告日期，没有文件名
      expect(again.body.existing).toEqual({
        uploadId: first.body.upload.id,
        // 这里没有给模拟厂商排识别结果，识别以失败结束；失败的也算已上传
        status: 'failed',
        reportId: null,
        reportDate: null,
      });
      expect(JSON.stringify(again.body)).not.toContain(FILE_NAME);
      const twice = await upload(agent, f.clients.a1[0], [
        { body: syntheticPng('x') },
        { body: syntheticPng('x') },
      ]).expect(409);
      expect(twice.body.reasons).toEqual(['duplicate_file']);
      expect(twice.body.existing).toBeNull();
      expect(storage.objects.size).toBe(1);

      // 别的客户可以传同一个文件（指纹按客户比对）
      await upload(agent, f.clients.a1[1], [{ body: file }]).expect(201);

      await agent.post(`/api/report-uploads/${first.body.upload.id}/discard`).expect(200);
      await upload(agent, f.clients.a1[0], [{ body: file }]).expect(201);
    });

    it('验收反馈 6：已核对的文件再上传，返回那份报告的 id 和日期；别的健管师传同一个文件不受影响', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const file = syntheticPng();
      provider.push(pageJson(STANDARD_ITEMS));
      const first = await upload(agent, f.clients.a1[0], [{ body: file }]).expect(201);
      await queue.idle();
      const u = (await agent.get(`/api/report-uploads/${first.body.upload.id}`).expect(200)).body
        .upload as ReportUpload;
      const ok = await verify(agent, u).expect(200);
      const again = await upload(agent, f.clients.a1[0], [{ body: file }]).expect(409);
      expect(again.body.existing).toEqual({
        uploadId: u.id,
        status: 'verified',
        reportId: ok.body.upload.reportId,
        reportDate: '2026-05-01',
      });
      // 别的健管师的客户：指纹按客户比对，不会看到别人的记录
      const other = await loginAs(app, f.users.managerA2.email);
      const res = await upload(other, f.clients.a2, [{ body: file }]).expect(201);
      expect(res.body.upload.id).not.toBe(u.id);
      // 别人拿同一个文件往 A1 的客户上传：先被拒绝，拿不到已有记录
      const probe = await upload(other, f.clients.a1[0], [{ body: file }]).expect(404);
      expect(probe.body.existing).toBeUndefined();
      expect(JSON.stringify(probe.body)).not.toContain(u.id);
    });

    it('对象存储写入失败时不留记录，已写的对象删掉', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      storage.failNextPut = true;
      await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }]).expect(500);
      expect(storage.objects.size).toBe(0);
      expect(await countRows('report_uploads')).toBe(0);
    });

    it('Q24：每位健管师每天最多识别 200 页，超出返回 429，不保存', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      await owner
        .insertInto('report_extraction_quota')
        .values({
          manager_id: f.users.managerA1.id,
          operator_id: f.operatorA,
          day: sql`current_date`,
          pages: 199,
        })
        .execute();
      const res = await upload(agent, f.clients.a1[0], [
        { body: await syntheticPdf(2), name: 'a.pdf', type: 'application/pdf' },
      ]).expect(429);
      expect(res.body.reasons).toEqual(['daily_page_limit']);
      expect(storage.objects.size).toBe(0);
      await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }]).expect(201);
      // 别的健管师不受影响
      const a2 = await loginAs(app, f.users.managerA2.email);
      await upload(a2, f.clients.a2, [{ body: syntheticPng() }]).expect(201);
    });

    it('在对话里上传：任务详情带上识别记录；任务属于别的客户时 404', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const task = (await agent.post('/api/tasks').send({ clientId: f.clients.a1[0] }).expect(201))
        .body.task.id as string;
      provider.push(pageJson([{ indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' }]));
      const res = await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }], task).expect(
        201,
      );
      expect(res.body.upload.taskId).toBe(task);
      await queue.idle();
      const detail = (await agent.get(`/api/tasks/${task}`).expect(200)).body;
      expect(detail.uploads).toEqual([
        expect.objectContaining({ id: res.body.upload.id, status: 'needs_review' }),
      ]);
      await upload(agent, f.clients.a1[1], [{ body: syntheticPng() }], task).expect(404);
      // 还没关联客户的任务：上传时关联到这位客户
      const blank = (await agent.post('/api/tasks').send({}).expect(201)).body.task.id as string;
      await upload(agent, f.clients.a1[1], [{ body: syntheticPng() }], blank).expect(201);
      expect((await agent.get(`/api/tasks/${blank}`)).body.task.clientId).toBe(f.clients.a1[1]);
      const other = (
        await (
          await loginAs(app, f.users.managerA2.email)
        )
          .post('/api/tasks')
          .send({ clientId: f.clients.a2 })
          .expect(201)
      ).body.task.id as string;
      await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }], other).expect(404);
    });
  });

  describe('核对和确认（规格 2.4）', () => {
    it('验收标准 5、6、10：逐行勾选、版本号、确认后只读、更正保留旧值', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0]);
      const attention = u.values.filter((v) => v.attention).map((v) => v.id);
      expect(attention).toHaveLength(3);

      // 需特别注意的行没有逐行勾选：后端拒绝
      const unchecked = await verify(agent, u, { checkedValueIds: attention.slice(1) }).expect(409);
      expect(unchecked.body.reasons).toEqual(['unchecked_attention']);
      expect(unchecked.body.valueIds).toEqual([attention[0]]);

      // 改一行：版本号加一，旧版本号确认被拒绝
      const weight = u.values.find((v) => v.code === 'weight')!;
      const edited = await agent
        .patch(`/api/report-uploads/${u.id}/values/${weight.id}`)
        .send({ rawValue: '65' })
        .expect(200);
      expect(edited.body.value).toMatchObject({ value: 65, flags: [], reviewStatus: 'edited' });
      expect(edited.body.version).toBe(u.version + 1);
      const stale = await verify(agent, u).expect(409);
      expect(stale.body.reasons).toEqual(['stale_version']);

      // 补录一行，删掉未收录的一行
      const added = await agent
        .post(`/api/report-uploads/${u.id}/values`)
        .send({ rawName: '收缩压', rawValue: '128', rawUnit: 'mmHg', refText: '90-139' })
        .expect(201);
      expect(added.body.value).toMatchObject({ code: 'sbp', value: 128, reviewStatus: 'added' });
      const unmapped = u.values.find((v) => v.code === null)!;
      const deleted = await agent
        .patch(`/api/report-uploads/${u.id}/values/${unmapped.id}`)
        .send({ deleted: true })
        .expect(200);
      expect(deleted.body.value.reviewStatus).toBe('deleted');

      const current = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload as ReportUpload;
      const ok = await verify(agent, current).expect(200);
      expect(ok.body.upload).toMatchObject({ status: 'verified', reportId: expect.any(String) });
      const reportId = ok.body.upload.reportId as string;

      // 已核对的识别记录不能再改
      await agent
        .patch(`/api/report-uploads/${u.id}/values/${weight.id}`)
        .send({ rawValue: '66' })
        .expect(409);
      await agent
        .post(`/api/report-uploads/${u.id}/values`)
        .send({ rawName: '舒张压', rawValue: '80', rawUnit: 'mmHg' })
        .expect(409);
      await verify(agent, ok.body.upload).expect(409);
      await agent.post(`/api/report-uploads/${u.id}/discard`).expect(409);

      const report = (await agent.get(`/api/reports/${reportId}`).expect(200)).body.report;
      expect(report).toMatchObject({
        reportDate: '2026-05-01',
        institution: '合成体检中心',
        source: 'upload',
        corrections: [],
        files: [expect.objectContaining({ mimeType: 'image/png', pageCount: 1 })],
      });
      const fpg = report.indicators.find((i: { code: string }) => i.code === 'fpg');
      expect(fpg).toMatchObject({
        value: 6.033,
        unit: 'mmol/L',
        originalValue: FPG_RAW,
        originalUnit: 'mg/dL',
        refText: '70-110',
        abnormal: 'normal',
      });
      const tc = report.indicators.find((i: { code: string }) => i.code === 'tc');
      expect(tc).toMatchObject({ value: 5.2, abnormal: 'high' });
      const sbp = report.indicators.find((i: { code: string }) => i.code === 'sbp');
      expect(sbp).toMatchObject({ value: 128, abnormal: 'normal' });
      expect(report.indicators.map((i: { code: string }) => i.code).sort()).toEqual([
        'fpg',
        'sbp',
        'tc',
        'weight',
      ]);

      // 更正一项：旧值保留在更正历史里
      const corrected = await agent
        .post(`/api/reports/${reportId}/indicators/${tc.id}/correct`)
        .send({ rawValue: '4.8', rawUnit: 'mmol/L', refText: '<5.2' })
        .expect(200);
      expect(
        corrected.body.report.indicators.find((i: { code: string }) => i.code === 'tc'),
      ).toMatchObject({ value: 4.8, abnormal: 'normal', supersededBy: null });
      expect(corrected.body.report.corrections).toEqual([
        expect.objectContaining({ id: tc.id, value: 5.2, supersededBy: expect.any(String) }),
      ]);
      // 已被更正的行不能再更正
      await agent
        .post(`/api/reports/${reportId}/indicators/${tc.id}/correct`)
        .send({ rawValue: '4.9' })
        .expect(409);

      // 趋势和档案只用当前值
      const trend = (
        await agent.get(`/api/clients/${f.clients.a1[0]}/indicators/tc/trend`).expect(200)
      ).body;
      expect(trend.points).toEqual([
        expect.objectContaining({ reportId, value: 4.8, abnormal: 'normal', refText: '<5.2' }),
      ]);
      const list = (await agent.get(`/api/clients/${f.clients.a1[0]}/reports`).expect(200)).body;
      expect(list.reports).toEqual([
        expect.objectContaining({ id: reportId, indicatorCount: 4, abnormalCount: 0 }),
        expect.objectContaining({ source: 'synthetic' }),
      ]);
    });

    it('没有参考范围的指标标为 no_reference；读不出数字或单位不认识要修改后才能确认', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '尿酸', value: '380', unit: 'μmol/L' },
        { indicator: '肌酐', value: '7?', unit: 'μmol/L', unreadable: true },
        { indicator: '甘油三酯', value: '1.5', unit: 'mg/ml' },
      ]);
      const [ua, cr, tg] = u.values;
      expect(ua).toMatchObject({ abnormal: 'no_reference', attention: false });
      expect(cr).toMatchObject({ value: null, flags: ['unreadable'], attention: true });
      expect(tg).toMatchObject({ value: null, flags: ['unit_unknown'], attention: true });
      const res = await verify(agent, u).expect(409);
      expect(res.body.reasons).toEqual(['missing_value']);
      expect(res.body.valueIds.sort()).toEqual([cr!.id, tg!.id].sort());

      await agent
        .patch(`/api/report-uploads/${u.id}/values/${cr!.id}`)
        .send({ rawValue: '75' })
        .expect(200);
      const fixed = await agent
        .patch(`/api/report-uploads/${u.id}/values/${tg!.id}`)
        .send({ rawUnit: 'mmol/L' })
        .expect(200);
      // 修改后要重新勾选（edits clear the tick）
      const latest = { ...u, version: fixed.body.version };
      await verify(agent, latest).expect(200);
    });

    it('同一份报告里同一指标出现两行：标为冲突，删掉一行才能确认', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
        { indicator: 'FPG', value: '5.3', unit: 'mmol/L' },
      ]);
      expect(u.values.map((v) => v.flags)).toEqual([[], ['conflict']]);
      const res = await verify(agent, u).expect(409);
      expect(res.body.reasons).toEqual(['duplicate_code']);
      const del = await agent
        .patch(`/api/report-uploads/${u.id}/values/${u.values[1]!.id}`)
        .send({ deleted: true })
        .expect(200);
      await verify(agent, { ...u, version: del.body.version }).expect(200);
    });

    it('Q17：同一报告日期已有报告时标出重复和冲突，要选“作为新报告保存”', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      // 夹具里这位客户 2026-01-01 有一份空腹血糖 5.5 的报告
      const u = await extracted(
        agent,
        f.clients.a1[0],
        [
          { indicator: '空腹血糖', value: '5.5', unit: 'mmol/L' },
          { indicator: '总胆固醇', value: '4.1', unit: 'mmol/L' },
        ],
        { reportDate: '2026-01-01' },
      );
      expect(u.sameDateReportIds).toHaveLength(1);
      expect(u.values[0]?.flags).toEqual(['duplicate']);
      const res = await verify(agent, u, { reportDate: '2026-01-01' }).expect(409);
      expect(res.body.reasons).toEqual(['same_date_report']);
      expect(res.body.sameDateReportIds).toEqual(u.sameDateReportIds);
      await verify(agent, u, { reportDate: '2026-01-01', saveAsNew: true }).expect(200);
    });

    it('验收标准 7：命中危急指标阈值时必须勾选“已知悉”', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '2.5', unit: 'mmol/L', referenceRange: '3.9-6.1' },
      ]);
      const res = await verify(agent, u).expect(409);
      expect(res.body.reasons).toEqual(['critical_unacknowledged']);
      expect(res.body.critical).toEqual([
        expect.objectContaining({ metric: 'fpg', value: 2.5, source: 'report' }),
      ]);
      const ok = await verify(agent, u, { acknowledgedCritical: true }).expect(200);
      expect(ok.body.upload.criticalAcknowledged).toBe(true);
      expect(ok.body.critical).toEqual([expect.objectContaining({ metric: 'fpg', value: 2.5 })]);
      // 逐行确认：记录里没有 confirm_all
      const events = await owner
        .selectFrom('report_events')
        .select('via')
        .where('upload_id', '=', u.id)
        .execute();
      expect(events.every((e) => e.via === null)).toBe(true);
      const report = (await agent.get(`/api/reports/${ok.body.upload.reportId}`)).body.report;
      expect(report.indicators[0]).toMatchObject({ value: 2.5, abnormal: 'low' });
    });

    it('验收反馈 4：没有确认“报告上的姓名是本客户”时拒绝，确认后记下谁、什么时候', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '总胆固醇', value: '4.1', unit: 'mmol/L', referenceRange: '<5.2' },
      ]);
      for (const body of [{ identityConfirmed: false }, { identityConfirmed: undefined }]) {
        const res = await verify(agent, u, body).expect(409);
        expect(res.body.reasons).toEqual(['identity_unconfirmed']);
      }
      // 一键确认也一样要确认身份
      const all = await verify(agent, u, { identityConfirmed: false, confirmAll: true }).expect(
        409,
      );
      expect(all.body.reasons).toEqual(['identity_unconfirmed']);
      const still = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload as ReportUpload;
      expect(still).toMatchObject({ status: 'needs_review', version: u.version });
      expect(still.values.every((v) => !v.checked)).toBe(true);

      await verify(agent, u).expect(200);
      const row = await owner
        .selectFrom('report_uploads')
        .select(['identity_confirmed_by', 'identity_confirmed_at', 'verified_at'])
        .where('id', '=', u.id)
        .executeTakeFirstOrThrow();
      expect(row.identity_confirmed_by).toBe(f.users.managerA1.id);
      expect(row.identity_confirmed_at).toEqual(row.verified_at);
    });

    it('验收反馈 2：确认所有数据一键勾选全部行并确认，不用逐行勾选和“已知悉”，危急指标照常流转', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        // 危急指标
        { indicator: '空腹血糖', value: '2.5', unit: 'mmol/L', referenceRange: '3.9-6.1' },
        { indicator: '总胆固醇', value: '4.1', unit: 'mmol/L', referenceRange: '<5.2' },
        // 需特别注意：超出合理范围、未收录指标
        { indicator: '体重', value: '650', unit: 'kg' },
        { indicator: '同型半胱氨酸', value: '12', unit: 'μmol/L', referenceRange: '0-15' },
      ]);
      expect(u.values.filter((v) => v.attention)).toHaveLength(2);
      // 先手动勾选一行：一键确认不重复记录这一行
      const weight = u.values.find((v) => v.code === 'weight')!;
      const ticked = await agent
        .patch(`/api/report-uploads/${u.id}/values/${weight.id}`)
        .send({ checked: true })
        .expect(200);

      const ok = await verify(
        agent,
        { ...u, version: ticked.body.version as number },
        { checkedValueIds: [], confirmAll: true },
      ).expect(200);
      const done = ok.body.upload as ReportUpload;
      expect(done).toMatchObject({ status: 'verified', criticalAcknowledged: true });
      // 不用勾选“已知悉”，但响应带上危急指标，界面确认后醒目列出
      expect(ok.body.critical).toEqual([
        expect.objectContaining({ metric: 'fpg', value: 2.5, source: 'report' }),
      ]);
      expect(done.values.every((v) => v.checked)).toBe(true);
      expect(done.values.find((v) => v.code === 'tc')?.reviewStatus).toBe('checked');

      // 每一行都记为当前健管师核对；先勾过的那一行只有一条记录
      const checked = await owner
        .selectFrom('extracted_values')
        .select(['checked_by'])
        .where('upload_id', '=', u.id)
        .execute();
      expect(checked.map((r) => r.checked_by)).toEqual(
        Array(4).fill(f.users.managerA1.id) as string[],
      );
      const events = await owner
        .selectFrom('report_events')
        .select(['action', 'actor_id', 'extracted_value_id', 'via'])
        .where('upload_id', '=', u.id)
        .where('action', '=', 'value_checked')
        .execute();
      expect(events).toHaveLength(4);
      expect(events.filter((e) => e.extracted_value_id === weight.id)).toEqual([
        expect.objectContaining({ via: null }),
      ]);
      // 审计：一键记下的勾选和确认都标明来自“确认所有数据”（含危急指标的知悉方式）
      expect(events.filter((e) => e.via === 'confirm_all')).toHaveLength(3);
      expect(new Set(events.map((e) => e.actor_id))).toEqual(new Set([f.users.managerA1.id]));
      const verifiedEvent = await owner
        .selectFrom('report_events')
        .select(['via', 'actor_id'])
        .where('upload_id', '=', u.id)
        .where('action', '=', 'verified')
        .executeTakeFirstOrThrow();
      expect(verifiedEvent).toEqual({ via: 'confirm_all', actor_id: f.users.managerA1.id });

      // 报告列表和档案里标出“含危急指标”
      const list = (await agent.get(`/api/clients/${f.clients.a1[0]}/reports`).expect(200)).body;
      // 夹具里那份没有危急指标的报告不标
      expect(
        (list.reports as { id: string; hasCritical: boolean }[]).map((r) => [r.id, r.hasCritical]),
      ).toEqual(
        expect.arrayContaining([
          [done.reportId, true],
          [expect.any(String), false],
        ]),
      );
      const record = (await agent.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200)).body
        .record;
      // 夹具里那份没有危急指标的报告不标
      expect(
        (record.reports as { id: string; hasCritical: boolean }[]).map((r) => [
          r.id,
          r.hasCritical,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [done.reportId, true],
          [expect.any(String), false],
        ]),
      );

      // 危急指标进入正式报告，并照常出现在健管师的客户上下文里（解读草稿和审核栏的危急指标来自这里）
      const report = (await agent.get(`/api/reports/${done.reportId}`)).body.report;
      expect(report.indicators).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'fpg', value: 2.5 })]),
      );
      const ctx = {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      };
      const context = await app.get(WorkbenchRepository).clientContext(ctx, f.clients.a1[0]);
      expect(context?.snapshot.criticalFlags).toEqual([
        expect.objectContaining({ metric: 'fpg', value: 2.5, source: 'report' }),
      ]);
    });

    it('确认所有数据：数值缺失、重复指标、同日报告仍然拒绝，并且一行都不改', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '5.5', unit: 'mmol/L' },
        // 单位不认识：目录指标没有数值
        { indicator: '总胆固醇', value: '4.1', unit: 'furlong' },
      ]);
      const missing = u.values.find((v) => v.code === 'tc')!;
      expect(missing.value).toBeNull();
      const res = await verify(agent, u, { checkedValueIds: [], confirmAll: true }).expect(409);
      expect(res.body.reasons).toEqual(['missing_value']);
      expect(res.body.valueIds).toEqual([missing.id]);
      const after = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload as ReportUpload;
      expect(after).toMatchObject({ status: 'needs_review', version: u.version });
      expect(after.values.every((v) => !v.checked)).toBe(true);
      expect(
        await owner
          .selectFrom('report_events')
          .select('id')
          .where('upload_id', '=', u.id)
          .where('action', '=', 'value_checked')
          .execute(),
      ).toHaveLength(0);

      // 删除那一行后可以一键确认
      const del = await agent
        .patch(`/api/report-uploads/${u.id}/values/${missing.id}`)
        .send({ deleted: true })
        .expect(200);
      await verify(
        agent,
        { ...u, version: del.body.version as number },
        { checkedValueIds: [], confirmAll: true },
      ).expect(200);
    });

    it('放弃后识别结果保留但不能再改、不能确认', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0]);
      await agent.post(`/api/report-uploads/${u.id}/discard`).expect(200);
      await verify(agent, u).expect(409);
      await agent
        .patch(`/api/report-uploads/${u.id}/values/${u.values[0]!.id}`)
        .send({ checked: true })
        .expect(409);
      const after = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload;
      expect(after.status).toBe('discarded');
      expect(after.values).toHaveLength(u.values.length);
    });

    it('勾选状态保存在后端，修改后需要重新勾选', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0]);
      const fpg = u.values.find((v) => v.code === 'fpg')!;
      const checked = await agent
        .patch(`/api/report-uploads/${u.id}/values/${fpg.id}`)
        .send({ checked: true })
        .expect(200);
      expect(checked.body.value.reviewStatus).toBe('checked');
      const edited = await agent
        .patch(`/api/report-uploads/${u.id}/values/${fpg.id}`)
        .send({ rawValue: '100' })
        .expect(200);
      expect(edited.body.value).toMatchObject({
        reviewStatus: 'edited',
        value: 5.55,
        checked: false,
      });
      // 验收反馈 5：修改过的行再勾选能勾上（reviewStatus 仍是 edited，checked 为 true）
      const rechecked = await agent
        .patch(`/api/report-uploads/${u.id}/values/${fpg.id}`)
        .send({ checked: true })
        .expect(200);
      expect(rechecked.body.value).toMatchObject({ reviewStatus: 'edited', checked: true });
      const current = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload as ReportUpload;
      expect(current.values.find((v) => v.id === fpg.id)?.checked).toBe(true);
      await verify(agent, current, {
        checkedValueIds: current.values.filter((v) => v.checked).map((v) => v.id),
      }).expect(409); // 体重、未收录指标两行还没勾
      const rest = current.values.filter((v) => v.attention && !v.checked);
      for (const v of rest) {
        await agent
          .patch(`/api/report-uploads/${u.id}/values/${v.id}`)
          .send({ checked: true })
          .expect(200);
      }
      const latest = (await agent.get(`/api/report-uploads/${u.id}`)).body.upload as ReportUpload;
      await verify(agent, latest, {
        checkedValueIds: latest.values.filter((v) => v.checked).map((v) => v.id),
      }).expect(200);
    });

    it('验收反馈 7：带代号的检验表格（合成样本）：未收录指标保留参考范围，核对后按报告参考范围标高低', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(
        agent,
        f.clients.a1[0],
        CODED_PANEL.map((r) => ({
          indicator: r.name,
          value: r.value,
          unit: r.unit,
          referenceRange: r.ref,
        })),
      );
      expect(u.values.map((v) => [v.rawName, v.code, v.refText, v.abnormal])).toEqual(
        CODED_PANEL.map((r, i) => [
          r.name,
          null,
          r.ref,
          ['normal', 'low', 'low', 'low', 'high', 'low'][i],
        ]),
      );
      const ok = await verify(agent, u).expect(200);
      const rows = await owner
        .selectFrom('report_indicators')
        .select(['raw_name', 'code', 'ref_text', 'ref_low', 'ref_high', 'abnormal'])
        .where('report_id', '=', ok.body.upload.reportId)
        .orderBy('raw_name')
        .execute();
      expect(rows).toHaveLength(CODED_PANEL.length);
      const byName = Object.fromEntries(rows.map((r) => [r.raw_name, r]));
      expect(byName['造血干细胞抗原CD34']).toMatchObject({
        code: null,
        ref_text: '0.1%-1.0%',
        abnormal: 'high',
      });
      expect(byName['单核细胞表面抗原CD14']).toMatchObject({ abnormal: 'normal' });
      expect(byName['Fcγ受体III（CD16）']).toMatchObject({ abnormal: 'low' });
    });

    it('验收反馈 7：未收录的行改成目录里的名称时按名称重新对应；明确选未收录时照原样保存', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '尿酸值', value: '400', unit: 'μmol/L', referenceRange: '150-420 μmol/L' },
        { indicator: '同型半胱氨酸', value: '16', unit: 'μmol/L', referenceRange: '(0-15)' },
        { indicator: '空腹血糖 GLU', value: '5.0', unit: 'mmol/L', referenceRange: '3.9-6.1' },
      ]);
      const [ua, hcy, fpg] = u.values;
      expect(ua).toMatchObject({ code: null, flags: ['unmapped'], abnormal: 'normal' });
      // 带括号的参考范围也能算出高低
      expect(hcy).toMatchObject({ code: null, refHigh: 15, abnormal: 'high' });
      expect(fpg).toMatchObject({ code: 'fpg', flags: [] });

      const renamed = await agent
        .patch(`/api/report-uploads/${u.id}/values/${ua!.id}`)
        .send({ rawName: '尿酸', rawValue: '400', rawUnit: 'μmol/L' })
        .expect(200);
      expect(renamed.body.value).toMatchObject({ code: 'uric_acid', flags: [] });

      const kept = await agent
        .patch(`/api/report-uploads/${u.id}/values/${hcy!.id}`)
        .send({ rawName: '同型半胱氨酸', code: null, rawValue: '16' })
        .expect(200);
      expect(kept.body.value).toMatchObject({ code: null, flags: ['unmapped'], abnormal: 'high' });
    });
  });

  describe('验收标准 4：未核对的识别结果不出现在档案、趋势、@ 列表和解读输入里', () => {
    it('待核对时档案、报告列表、趋势里只有夹具的报告；@ 未核对的记录 404', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '7.1', unit: 'mmol/L' },
      ]);
      const record = (await agent.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200)).body
        .record;
      expect(record.reports).toHaveLength(1);
      expect(record.reports[0].source).toBe('synthetic');
      expect(record.indicators[0].points.map((p: { value: number }) => p.value)).toEqual([5.5]);
      const reports = (await agent.get(`/api/clients/${f.clients.a1[0]}/reports`)).body.reports;
      expect(reports.map((r: { source: string }) => r.source)).toEqual(['synthetic']);
      const trend = (await agent.get(`/api/clients/${f.clients.a1[0]}/indicators/fpg/trend`)).body;
      expect(trend.points.map((p: { value: number }) => p.value)).toEqual([5.5]);

      const task = (await agent.post('/api/tasks').send({ clientId: f.clients.a1[0] }).expect(201))
        .body.task.id as string;
      // 用识别记录的 id 或不存在的 id 当报告引用：404
      for (const ref of [u.id, randomUUID()]) {
        await agent
          .post(`/api/tasks/${task}/messages`)
          .send({ mode: 'ask', content: '看看这份报告', reportRefs: [ref] })
          .expect(404);
      }
      await agent
        .post(`/api/tasks/${task}/messages`)
        .send({ mode: 'skill', skillId: 'checkup-interpretation', content: '', reportRefs: [u.id] })
        .expect((res) => expect([400, 404]).toContain(res.status));
    });

    it('@ 已核对的报告：引用保存在消息上；别的客户的报告 404', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const u = await extracted(agent, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
      ]);
      const ok = await verify(agent, u).expect(200);
      const reportId = ok.body.upload.reportId as string;
      const task = (await agent.post('/api/tasks').send({ clientId: f.clients.a1[0] }).expect(201))
        .body.task.id as string;
      provider.queue.push({ text: '好的。' });
      await agent
        .post(`/api/tasks/${task}/messages`)
        .send({ mode: 'ask', content: '这份报告怎么样', reportRefs: [reportId] })
        .expect(200);
      const detail = (await agent.get(`/api/tasks/${task}`)).body;
      const userMessage = detail.messages.find((m: { role: string }) => m.role === 'manager');
      expect(userMessage.reportRefs).toEqual([reportId]);

      const other = (
        await owner
          .selectFrom('health_reports')
          .select('id')
          .where('client_id', '=', f.clients.a1[1])
          .executeTakeFirst()
      )?.id;
      const b1Report = (
        await owner
          .selectFrom('health_reports')
          .select('id')
          .where('client_id', '=', f.clients.b1)
          .executeTakeFirstOrThrow()
      ).id as string;
      for (const ref of [other, b1Report].filter(Boolean)) {
        await agent
          .post(`/api/tasks/${task}/messages`)
          .send({ mode: 'ask', content: '这份呢', reportRefs: [ref] })
          .expect(404);
      }
    });
  });

  describe('原件查看（验收标准 23）', () => {
    it('原件只通过后端接口查看，响应不缓存、文件名固定；每次查看记录一条事件', async () => {
      const agent = await loginAs(app, f.users.managerA1.email);
      const png = syntheticPng();
      const pdf = await syntheticPdf(2);
      provider.push(pageJson([]), pageJson([]), pageJson([]));
      const res = await upload(agent, f.clients.a1[0], [
        { body: png },
        { body: pdf, name: '张小明.pdf', type: 'application/pdf' },
      ]).expect(201);
      const [pngFile, pdfFile] = res.body.upload.files;

      const img = await agent.get(`/api/report-files/${pngFile.id}/content`).expect(200);
      expect(img.headers['cache-control']).toBe('no-store, private');
      expect(img.headers['pragma']).toBe('no-cache');
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['content-disposition']).toBe('inline; filename="report-page-1.png"');
      expect(Buffer.from(img.body).equals(png)).toBe(true);

      const page2 = await agent
        .get(`/api/report-files/${pdfFile.id}/content?page=2`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(page2.headers['content-type']).toBe('application/pdf');
      expect(page2.headers['cache-control']).toBe('no-store, private');
      expect((page2.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(page2.headers['content-disposition']).not.toContain('张小明');

      await agent.get(`/api/report-files/${pdfFile.id}/content?page=3`).expect(404);
      await agent.get(`/api/report-files/${pdfFile.id}/content?page=0`).expect(400);

      const views = await owner
        .selectFrom('report_events')
        .select(['file_id', 'actor_id'])
        .where('action', '=', 'file_viewed')
        .execute();
      expect(views).toHaveLength(2);
      expect(views.every((v) => v.actor_id === f.users.managerA1.id)).toBe(true);
    });
  });

  describe('跨租户访问被拒绝（验收标准 18、19）', () => {
    /** A1 的一份待核对和一份已核对的识别记录 */
    async function setup() {
      const agent = await loginAs(app, f.users.managerA1.email);
      const pending = await extracted(agent, f.clients.a1[0]);
      const done = await extracted(
        agent,
        f.clients.a1[0],
        [{ indicator: '空腹血糖', value: '5.1', unit: 'mmol/L', referenceRange: '3.9-6.1' }],
        { reportDate: '2026-06-01' },
      );
      const verified = (await verify(agent, done, { reportDate: '2026-06-01' }).expect(200)).body
        .upload as ReportUpload;
      const report = (await agent.get(`/api/reports/${verified.reportId}`)).body.report;
      return { pending, verified, report };
    }

    /** 每个新接口：别人的数据一律 404 */
    async function expectAllDenied(
      account: Account,
      ids: Awaited<ReturnType<typeof setup>>,
      { reportsReadable = false }: { reportsReadable?: boolean } = {},
    ) {
      const other = await loginAs(app, account.email);
      const c = f.clients.a1[0];
      const { pending, verified, report } = ids;
      const valueId = pending.values[0]!.id;
      const fileId = pending.files[0]!.id;
      const indicatorId = report.indicators[0].id as string;
      const calls: [string, () => request.Test][] = [
        ['upload', () => upload(other, c, [{ body: syntheticPng() }])],
        ['list uploads', () => other.get(`/api/clients/${c}/report-uploads`)],
        ['get upload', () => other.get(`/api/report-uploads/${pending.id}`)],
        ['get verified upload', () => other.get(`/api/report-uploads/${verified.id}`)],
        ['events', () => other.get(`/api/report-uploads/${pending.id}/events`)],
        ['retry', () => other.post(`/api/report-uploads/${pending.id}/retry`)],
        ['discard', () => other.post(`/api/report-uploads/${pending.id}/discard`)],
        [
          'update value',
          () =>
            other
              .patch(`/api/report-uploads/${pending.id}/values/${valueId}`)
              .send({ checked: true }),
        ],
        [
          'add value',
          () =>
            other
              .post(`/api/report-uploads/${pending.id}/values`)
              .send({ rawName: '收缩压', rawValue: '120', rawUnit: 'mmHg' }),
        ],
        ['verify', () => verify(other, pending)],
        [
          'verify confirm-all',
          () => verify(other, pending, { checkedValueIds: [], confirmAll: true }),
        ],
        ['file content', () => other.get(`/api/report-files/${fileId}/content`)],
        [
          'correct',
          () =>
            other
              .post(`/api/reports/${report.id}/indicators/${indicatorId}/correct`)
              .send({ rawValue: '5.0' }),
        ],
      ];
      if (!reportsReadable) {
        calls.push(
          ['list reports', () => other.get(`/api/clients/${c}/reports`)],
          ['get report', () => other.get(`/api/reports/${report.id}`)],
          ['trend', () => other.get(`/api/clients/${c}/indicators/fpg/trend`)],
        );
      }
      for (const [name, call] of calls) {
        const res = await call();
        expect(res.status, `${account.email} ${name}`).toBe(404);
        expect(JSON.stringify(res.body), name).not.toContain('测试客户');
      }
      return other;
    }

    it('同协会其他健管师、协会B的健管师、运营商和平台管理员：每个接口都是 404', async () => {
      const ids = await setup();
      for (const account of [
        f.users.managerA2,
        f.users.managerA3,
        f.users.managerB1,
        f.users.operatorAdminA,
        f.users.platform,
        f.users.orgAdminA2,
      ]) {
        await expectAllDenied(account, ids);
      }
      // 什么都没被改
      const pending = (
        await (
          await loginAs(app, f.users.managerA1.email)
        ).get(`/api/report-uploads/${ids.pending.id}`)
      ).body.upload;
      expect(pending.version).toBe(ids.pending.version);
      expect(pending.status).toBe('needs_review');
      // 一键确认被拒绝：没有任何一行被记为已核对
      expect(pending.values.filter((v: { checked: boolean }) => v.checked)).toEqual(
        ids.pending.values.filter((v) => v.checked),
      );
      expect(await countRows('report_uploads')).toBe(2);
    });

    it('Q14：机构管理员只读已核对的报告和趋势，读不到原件、待核对结果，也不能更正', async () => {
      const ids = await setup();
      const admin = await expectAllDenied(f.users.orgAdminA, ids, { reportsReadable: true });
      const list = (await admin.get(`/api/clients/${f.clients.a1[0]}/reports`).expect(200)).body;
      expect(list.reports.map((r: { id: string }) => r.id)).toContain(ids.report.id);
      const report = (await admin.get(`/api/reports/${ids.report.id}`).expect(200)).body.report;
      expect(report.indicators).toHaveLength(1);
      expect(report.files).toEqual([]);
      const trend = (
        await admin.get(`/api/clients/${f.clients.a1[0]}/indicators/fpg/trend`).expect(200)
      ).body;
      expect(trend.points.length).toBe(2);
    });
  });

  describe('客户转出（Q23，验收标准 21）', () => {
    it('排队中、待核对的识别记录作废，原件跟着客户走，新健管师可以重新识别；已核对的跟着转', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const done = await extracted(a1, f.clients.a1[0], [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
      ]);
      const verified = (await verify(a1, done).expect(200)).body.upload as ReportUpload;
      const pending = await extracted(a1, f.clients.a1[0]);
      queue.paused = true;
      const task = (await a1.post('/api/tasks').send({ clientId: f.clients.a1[0] }).expect(201))
        .body.task.id as string;
      const queuedRes = await upload(a1, f.clients.a1[0], [{ body: syntheticPng() }], task).expect(
        201,
      );
      const queuedId = queuedRes.body.upload.id as string;

      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();

      for (const id of [pending.id, queuedId, verified.id]) {
        await a1.get(`/api/report-uploads/${id}`).expect(404);
      }
      await a1.get(`/api/reports/${verified.reportId}`).expect(404);

      const a2 = await loginAs(app, f.users.managerA2.email);
      const p = (await a2.get(`/api/report-uploads/${pending.id}`).expect(200)).body.upload;
      expect(p).toMatchObject({
        status: 'failed',
        failureCategory: 'transferred',
        attempts: 0,
        values: [],
        taskId: null,
      });
      const q = (await a2.get(`/api/report-uploads/${queuedId}`).expect(200)).body.upload;
      expect(q).toMatchObject({ status: 'failed', failureCategory: 'transferred', taskId: null });
      const v = (await a2.get(`/api/report-uploads/${verified.id}`).expect(200)).body.upload;
      expect(v.status).toBe('verified');
      await a2.get(`/api/reports/${verified.reportId}`).expect(200);
      // 原件跟着客户走
      await a2.get(`/api/report-files/${p.files[0].id}/content`).expect(200);

      // 转出前已入队的任务执行时读不到数据，以失败结束
      queue.resume();
      await queue.idle();
      expect(queue.jobs.find((j) => j.data.uploadId === queuedId)?.outcome).toBe('failed');

      // 新健管师重新识别
      provider.push(
        pageJson([{ indicator: '空腹血糖', value: '5.4', unit: 'mmol/L' }], {
          reportDate: '2026-07-01',
        }),
      );
      const retried = await a2.post(`/api/report-uploads/${pending.id}/retry`).expect(200);
      expect(retried.body.upload.attempts).toBe(1);
      await queue.idle();
      const after = (await a2.get(`/api/report-uploads/${pending.id}`)).body.upload;
      expect(after.status).toBe('needs_review');
      expect(after.values).toHaveLength(1);
      const events = await owner
        .selectFrom('report_events')
        .select(['action', 'manager_id'])
        .where('upload_id', '=', pending.id)
        .where('action', '=', 'transferred')
        .execute();
      expect(events).toEqual([{ action: 'transferred', manager_id: f.users.managerA2.id }]);
    });
  });

  describe('产物标题用的报告日期和原件文件名（M2 规格 2.11）跟着行级安全走', () => {
    it('真实上传并核对的报告：转出前原健管师能看到文件名，转出后为空；机构管理员档案里没有产物', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const clientId = f.clients.a1[1];
      const done = await extracted(a1, clientId, [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L', referenceRange: '3.9-6.1' },
      ]);
      const verified = (await verify(a1, done).expect(200)).body.upload as ReportUpload;
      const taskId = (await a1.post('/api/tasks').send({ clientId }).expect(201)).body.task
        .id as string;
      // /面谈提纲 走 skill 用途，模拟厂商按顺序返回下一条脚本
      provider.push(
        JSON.stringify({
          professional: {
            overview: '重点了解饮食。',
            groups: [
              {
                topic: 'diet',
                questions: [{ question: '您晚餐一般吃些什么？', why: '空腹血糖 5.1 mmol/L' }],
              },
            ],
            missingData: [],
            suggestions: [],
          },
          crisisSignal: false,
        }),
      );
      const sent = await a1
        .post(`/api/tasks/${taskId}/messages`)
        .send({
          mode: 'craft',
          content: '列个面谈提纲',
          skillId: 'interview-outline',
          reportRefs: [verified.reportId],
        })
        .expect(200);
      expect(sent.text).toContain('"type":"artifact"');

      const before = (await a1.get(`/api/tasks/${taskId}`).expect(200)).body.artifacts;
      expect(before).toEqual([
        expect.objectContaining({ sourceReportDate: '2026-05-01', sourceFileName: FILE_NAME }),
      ]);
      const artifactId = before[0].id as string;
      expect(
        (await a1.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact,
      ).toMatchObject({ sourceReportDate: '2026-05-01', sourceFileName: FILE_NAME });

      // 机构管理员只读档案：产物不在档案里（Q14），也就看不到文件名
      const admin = await loginAs(app, f.users.orgAdminA.email);
      const adminRecord = async () =>
        (await admin.get(`/api/clients/${clientId}/record`).expect(200)).body.record;
      expect((await adminRecord()).artifacts).toEqual([]);
      expect(JSON.stringify(await adminRecord())).not.toContain(FILE_NAME);

      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', clientId)
        .execute();

      // 原健管师仍能看到自己的任务和已作废的产物，但报告和原件已跟着客户走：日期和文件名都取不到
      const after = (await a1.get(`/api/tasks/${taskId}`).expect(200)).body.artifacts;
      expect(after).toEqual([
        expect.objectContaining({
          id: artifactId,
          status: 'voided',
          sourceReportDate: null,
          sourceFileName: null,
        }),
      ]);
      expect(
        (await a1.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact,
      ).toMatchObject({ sourceReportDate: null, sourceFileName: null });
      // 新健管师看不到原健管师的产物
      const a2 = await loginAs(app, f.users.managerA2.email);
      await a2.get(`/api/tasks/${taskId}`).expect(404);
      await a2.get(`/api/artifacts/${artifactId}`).expect(404);
      expect((await adminRecord()).artifacts).toEqual([]);
    });
  });

  describe('队列任务（验收标准 22）', () => {
    it('构造的任务：不存在的、别人已核对的、已在待核对的 upload_id 都读不到数据并以失败结束', async () => {
      const b1 = await loginAs(app, f.users.managerB1.email);
      const b1Upload = await extracted(b1, f.clients.b1, [
        { indicator: '空腹血糖', value: '5.1', unit: 'mmol/L' },
      ]);
      const verified = (await verify(b1, b1Upload).expect(200)).body.upload as ReportUpload;
      const a1 = await loginAs(app, f.users.managerA1.email);
      const pending = await extracted(a1, f.clients.a1[0]);
      provider.reset();
      for (const uploadId of [randomUUID(), verified.id, pending.id, 'not-a-uuid']) {
        expect(await queue.run({ uploadId, attempt: 1 }), uploadId).toBe('failed');
      }
      expect(provider.calls).toHaveLength(0);
      const after = (await a1.get(`/api/report-uploads/${pending.id}`)).body.upload;
      expect(after.version).toBe(pending.version);
      expect(after.status).toBe('needs_review');
    });

    it('同一次识别的重复任务：识别中时读不到；次数不对的读不到；超过 10 分钟没有进度的可以重新认领', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      queue.paused = true;
      const res = await upload(a1, f.clients.a1[0], [{ body: syntheticPng() }]).expect(201);
      const uploadId = res.body.upload.id as string;
      // 第一个任务已认领、正在识别
      const ctx = {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      };
      expect(await app.get(ReportsRepository).claimExtraction(ctx, uploadId, 1)).toBeDefined();
      expect(await queue.run({ uploadId, attempt: 1 })).toBe('failed');
      expect(await queue.run({ uploadId, attempt: 2 })).toBe('failed');
      expect(provider.calls).toHaveLength(0);
      const status = async () =>
        await owner
          .selectFrom('report_uploads')
          .select(['status', 'claimed_attempt'])
          .where('id', '=', uploadId)
          .executeTakeFirstOrThrow();
      expect(await status()).toEqual({ status: 'processing', claimed_attempt: 1 });

      // 服务重启等：识别中但 10 分钟没有进度，同一次识别的任务可以重新认领
      await sql`alter table report_uploads disable trigger report_uploads_guard`.execute(owner);
      try {
        await owner
          .updateTable('report_uploads')
          .set({ updated_at: sql`now() - interval '11 minutes'` })
          .where('id', '=', uploadId)
          .execute();
      } finally {
        await sql`alter table report_uploads enable trigger report_uploads_guard`.execute(owner);
      }
      provider.push(pageJson(STANDARD_ITEMS));
      expect(await queue.run({ uploadId, attempt: 1 })).toBe('completed');
      expect((await status()).status).toBe('needs_review');
      queue.jobs.length = 0;
    });

    it('Q24：入队失败时记录改为失败并退还预占的页数，只退一次；重新识别再计入', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      const pages = async () =>
        (
          await owner
            .selectFrom('report_extraction_quota')
            .select('pages')
            .where('manager_id', '=', f.users.managerA1.id)
            .executeTakeFirst()
        )?.pages;
      queue.failNextEnqueue = true;
      const res = await upload(a1, f.clients.a1[0], [
        { body: await syntheticPdf(2), name: 'a.pdf', type: 'application/pdf' },
      ]).expect(201);
      const uploadId = res.body.upload.id as string;
      expect(res.body.upload.status).toBe('failed');
      expect(await pages()).toBe(0);

      queue.paused = true;
      await a1.post(`/api/report-uploads/${uploadId}/retry`).expect(200);
      expect(await pages()).toBe(2);
    });

    it('发起人停用后排队中的任务以失败结束', async () => {
      const a1 = await loginAs(app, f.users.managerA1.email);
      queue.paused = true;
      const res = await upload(a1, f.clients.a1[0], [{ body: syntheticPng() }]).expect(201);
      await owner
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', f.users.managerA1.id)
        .execute();
      queue.resume();
      await queue.idle();
      expect(queue.jobs[0]?.outcome).toBe('failed');
      expect(provider.calls).toHaveLength(0);
      const row = await owner
        .selectFrom('report_uploads')
        .select('status')
        .where('id', '=', res.body.upload.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('queued');
    });
  });

  describe('验收标准 24：日志、错误、SSE 和任务参数里没有姓名、文件名、数值和原文', () => {
    it('走完上传、识别失败、重试、核对、更正、查看原件，捕获的输出里搜不到敏感内容', async () => {
      const captured: string[] = [];
      const capture = (...args: unknown[]) => {
        captured.push(
          args
            .map((a) =>
              a instanceof Error
                ? `${a.name} ${a.message} ${a.stack}`
                : typeof a === 'string'
                  ? a
                  : JSON.stringify(a),
            )
            .join(' '),
        );
      };
      const spies = [
        vi.spyOn(Logger.prototype, 'log').mockImplementation(capture),
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
        vi.spyOn(Logger.prototype, 'error').mockImplementation(capture),
        vi.spyOn(Logger.prototype, 'debug').mockImplementation(capture),
        vi.spyOn(Logger, 'log').mockImplementation(capture),
        vi.spyOn(Logger, 'warn').mockImplementation(capture),
        vi.spyOn(Logger, 'error').mockImplementation(capture),
        vi.spyOn(console, 'log').mockImplementation(capture),
        vi.spyOn(console, 'warn').mockImplementation(capture),
        vi.spyOn(console, 'error').mockImplementation(capture),
      ];
      const bodies: string[] = [];
      try {
        const agent = await loginAs(app, f.users.managerA1.email);
        // 第一次：厂商出错，错误消息里带着原文
        provider.queue.push({ error: new Error(`provider failed on ${FPG_SNIPPET} ${FILE_NAME}`) });
        const res = await upload(agent, f.clients.a1[0], [{ body: syntheticPng() }]).expect(201);
        bodies.push(JSON.stringify(res.body.upload.values));
        await queue.idle();
        const id = res.body.upload.id as string;
        const failedSse = await agent.get(`/api/report-uploads/${id}/events`);
        bodies.push(failedSse.text);

        // 重试成功
        provider.push(pageJson(STANDARD_ITEMS));
        await agent.post(`/api/report-uploads/${id}/retry`).expect(200);
        await queue.idle();
        bodies.push((await agent.get(`/api/report-uploads/${id}/events`)).text);
        const u = (await agent.get(`/api/report-uploads/${id}`)).body.upload as ReportUpload;

        // 被拒绝的确认和各种错误
        const rejected = await verify(agent, u, { checkedValueIds: [] });
        bodies.push(JSON.stringify(rejected.body));
        bodies.push(
          JSON.stringify(
            (await upload(agent, f.clients.a1[0], [{ body: renamedExe(), name: FILE_NAME }])).body,
          ),
        );
        const ok = await verify(agent, u).expect(200);
        const report = (await agent.get(`/api/reports/${ok.body.upload.reportId}`)).body.report;
        await agent
          .post(`/api/reports/${report.id}/indicators/${report.indicators[0].id}/correct`)
          .send({ rawValue: '99.9' })
          .expect(200);
        await agent.get(`/api/report-files/${u.files[0]!.id}/content`).expect(200);
      } finally {
        for (const s of spies) s.mockRestore();
      }

      const jobParams = JSON.stringify(queue.jobs.map((j) => j.data));
      expect(jobParams).toMatch(
        /^\[\{"uploadId":"[0-9a-f-]{36}","attempt":[1-3]\}(,\{"uploadId":"[0-9a-f-]{36}","attempt":[1-3]\})*\]$/,
      );
      const logs = captured.join('\n');
      expect(logs).toContain('report extraction');
      const forbidden = [
        '测试客户',
        '张小明',
        FILE_NAME,
        FPG_RAW,
        '99.9',
        FPG_SNIPPET,
        '合成体检中心',
        '同型半胱氨酸',
        REPORT_EXTRACTION_PROMPT.slice(0, 30),
        'provider failed on',
      ];
      for (const text of forbidden) {
        expect(logs, `logs contain ${text}`).not.toContain(text);
        expect(jobParams).not.toContain(text);
        // SSE 和错误响应
        for (const b of bodies.slice(1)) expect(b, `body contains ${text}`).not.toContain(text);
      }
    });
  });
});

describe('没有配置对象存储和队列时', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
  });
  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('服务能启动；上传和重新识别返回 503 not_configured，其他接口照常', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent
      .post(`/api/clients/${f.clients.a1[0]}/report-uploads`)
      .attach('files', syntheticPng(), { filename: 'a.png', contentType: 'image/png' })
      .expect(503);
    expect(res.body).toEqual({ error: 'not_configured' });
    await agent.post(`/api/report-uploads/${randomUUID()}/retry`).expect(503);
    const list = await agent.get(`/api/clients/${f.clients.a1[0]}/report-uploads`).expect(200);
    expect(list.body.uploads).toEqual([]);
    await agent.get(`/api/clients/${f.clients.a1[0]}/reports`).expect(200);
    // 别人的客户仍然是 404（不因为未配置而泄露存在与否）
    const b1 = await loginAs(app, f.users.managerB1.email);
    await b1.get(`/api/clients/${f.clients.a1[0]}/report-uploads`).expect(404);
    // 非健管师先按“不存在”处理
    const admin = await loginAs(app, f.users.orgAdminA.email);
    await admin
      .post(`/api/clients/${f.clients.a1[0]}/report-uploads`)
      .attach('files', syntheticPng(), { filename: 'a.png', contentType: 'image/png' })
      .expect(404);
  });
});
