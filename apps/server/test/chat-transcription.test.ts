import { CHAT_TRANSCRIPTION_PROMPT } from '@health-buddy/skills';
import { Logger, type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { ExtractionProvider, renamedExe, syntheticPdf, syntheticPng } from './report-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * 聊天截图转写（M5 规格 2.9“聊天截图”，Q21 改为 B）：只返回文字，不保存任何东西；
 * 转写结果核对后用 source = screenshot 上传。跨租户一律 404，不调用模型。全部是合成数据。
 */
describe('聊天截图转写', () => {
  const owner = ownerDb();
  const provider = new ExtractionProvider();
  let app: INestApplication;
  let f: Fixtures;

  const chat = (messages: { speaker: string; text: string }[], category = 'chat') =>
    JSON.stringify({ category, messages });
  const transcribe = (
    agent: Agent,
    clientId: string,
    files: Buffer[] = [syntheticPng()],
    consent?: boolean,
  ) => {
    let req = agent.post(`/api/clients/${clientId}/visit-materials/transcribe`);
    if (consent) req = req.field('consentConfirmed', 'true');
    for (const [i, body] of files.entries()) {
      req = req.attach('files', body, { filename: `shot-${i}.png`, contentType: 'image/png' });
    }
    return req;
  };
  const materialCount = async () =>
    Number(
      (
        await owner
          .selectFrom('visit_materials')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

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

  it('转写成“健管师：……”“客户：……”，电话按格式去掉；不保存任何东西；日志里没有原文', async () => {
    const a1 = await as(f.users.managerA1.email);
    const logs = vi.spyOn(Logger.prototype, 'log');
    provider.push(
      chat([
        { speaker: 'system', text: '昨天 19:32' },
        { speaker: 'manager', text: '这周散步怎么样？' },
        { speaker: 'client', text: '走了三次，电话 13812345678 换了' },
        { speaker: 'other', text: '我妈膝盖疼' },
      ]),
    );
    const res = await transcribe(a1, f.clients.a1[0], [syntheticPng(), syntheticPng()], true);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.imageCount).toBe(2);
    expect(res.body.text).toContain('【昨天 19:32】');
    expect(res.body.text).toContain('健管师：这周散步怎么样？');
    expect(res.body.text).toContain('其他人：我妈膝盖疼');
    expect(res.body.text).not.toContain('13812345678');

    // 一次调用、两张图、用转写提示词，消息里没有客户资料
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.system).toBe(CHAT_TRANSCRIPTION_PROMPT);
    const content = JSON.stringify(call.messages);
    expect(content.match(/"image"/g)).toHaveLength(2);
    expect(content).not.toContain('测试客户');

    expect(await materialCount()).toBe(0);
    expect(await owner.selectFrom('client_record_consents').selectAll().execute()).toHaveLength(0);
    const logged = logs.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('chat transcription');
    expect(logged).not.toContain('散步');
    logs.mockRestore();

    // 核对后上传：来源记为 screenshot
    const saved = await a1
      .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
      .send({ text: res.body.text, source: 'screenshot', consentConfirmed: true })
      .expect(201);
    expect(saved.body.material.kind).toBe('screenshot');
  });

  it('首次未勾选“已告知客户”400；不是图片（PDF、改名的可执行文件）415；都不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const res = await transcribe(a1, f.clients.a1[0]);
    expect(res.status).toBe(400);
    expect(res.body.reasons).toEqual(['consent_required']);
    for (const body of [await syntheticPdf(1), renamedExe()]) {
      await transcribe(a1, f.clients.a1[0], [body], true).expect(415);
    }
    await transcribe(a1, f.clients.a1[0], [], true).expect(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('超过 9 张 413，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const files = Array.from({ length: 10 }, () => syntheticPng());
    const res = await transcribe(a1, f.clients.a1[0], files, true);
    expect(res.status).toBe(413);
    expect(res.body.reasons).toEqual(['too_many_files']);
    expect(provider.calls).toHaveLength(0);
  });

  it('不是聊天截图、看不清、模型拒绝处理 → 422 transcription_failed，带原因', async () => {
    const a1 = await as(f.users.managerA1.email);
    provider.push(chat([], 'not_a_chat'), chat([], 'unreadable'));
    provider.queue.push({ finishReason: 'refused' });
    for (const reason of ['not_a_chat', 'unreadable', 'refused']) {
      const res = await transcribe(a1, f.clients.a1[0], undefined, true);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'transcription_failed', reasons: [reason] });
    }
    provider.queue.push({ error: new Error('upstream exploded') });
    const res = await transcribe(a1, f.clients.a1[0], undefined, true);
    expect(res.status).toBe(422);
    expect(res.body.reasons).toEqual(['error']);
  });

  it('跨租户访问被拒绝：别人的客户、别的运营商的客户 → 404；非健管师 → 404；都不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const b1 = await as(f.users.managerB1.email);
    for (const clientId of [f.clients.a2, f.clients.a3, f.clients.b1]) {
      await transcribe(a1, clientId, undefined, true).expect(404);
    }
    await transcribe(b1, f.clients.a1[0], undefined, true).expect(404);
    const orgAdmin = await as(f.users.orgAdminA.email);
    await transcribe(orgAdmin, f.clients.a1[0], undefined, true).expect(404);
    expect(provider.calls).toHaveLength(0);
  });

  async function as(email: string): Promise<Agent> {
    return loginAs(app, email);
  }
});
