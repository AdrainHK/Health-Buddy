import type { INestApplication } from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { insertTask, type Scope } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M8 第 5 步：科普的复制和导出（规格 2.1 第 7、8 条，Q1、Q5）。只有已审核的能交付；
 * 文章导出 Word 和 PDF、PPT 导出 PPTX、社群稿只复制。末尾带固定提示和署名。合成数据。
 */

/** 读 zip（docx、pptx）里的一个文件：只认本地文件头，够测试用 */
function readZipEntry(zip: Buffer, name: string): string | null {
  let at = 0;
  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const extraLen = zip.readUInt16LE(at + 28);
    const entry = zip.subarray(at + 30, at + 30 + nameLen).toString();
    const start = at + 30 + nameLen + extraLen;
    const data = zip.subarray(start, start + size);
    if (entry === name) return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    at = start + size;
  }
  return null;
}

const ARTICLE = {
  kind: 'popsci_article',
  title: '冬季怎样管理血压',
  sections: [{ heading: '天冷要保暖', body: '出门注意保暖，避免突然受凉。' }],
  summary: '养成规律的作息。',
};
const DECK = {
  kind: 'lecture_deck',
  title: '老年人冬季健康',
  slides: [{ title: '保暖', bullets: ['出门戴帽子', '室内温度适宜'], notes: '合成讲稿' }],
};
const POST = {
  kind: 'community_post',
  paragraphs: ['今天聊聊冬季睡眠。'],
  interaction: '你每天几点睡？',
};
const SKILL: Record<string, string> = {
  popsci_article: 'popsci-article',
  lecture_deck: 'lecture-deck',
  community_post: 'community-post',
};

describe('科普的复制和导出', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let a1: Scope;
  let b1: Scope;

  const insert = async (
    scope: Scope,
    structured: { kind: string },
    status: 'draft' | 'approved' = 'approved',
  ) => {
    const taskId = await insertTask(owner, scope);
    const id = crypto.randomUUID();
    await owner
      .insertInto('artifacts')
      .values({
        id,
        operator_id: scope.operatorId,
        org_id: scope.orgId,
        manager_id: scope.managerId,
        task_id: taskId,
        client_id: null,
        skill_id: SKILL[structured.kind]!,
        kind: structured.kind,
        lineage_id: id,
        version: 1,
        status: 'draft',
        content: JSON.stringify({ professional: '', clientFacing: '' }),
        critical_flags: '[]',
        structured: JSON.stringify(structured),
      })
      .execute();
    if (status === 'approved') {
      // 模拟审核通过：先有对应当前内容的检查结果，再改为已审核（数据库第二道把关要求）
      await owner
        .insertInto('content_compliance_results')
        .values({
          artifact_id: id,
          operator_id: scope.operatorId,
          org_id: scope.orgId,
          manager_id: scope.managerId,
          rules_version: 1,
          hits: '[]',
        })
        .execute();
      await owner
        .updateTable('artifacts')
        .set({ status: 'approved' })
        .where('id', '=', id)
        .execute();
    }
    return id;
  };
  const exportAs = (agent: Agent, id: string, format: string) =>
    agent
      .post(`/api/artifacts/${id}/export`)
      .send({ format })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  const formatsOf = async (id: string) =>
    (
      await owner
        .selectFrom('artifact_events')
        .select(['action', 'format'])
        .where('artifact_id', '=', id)
        .orderBy('created_at')
        .execute()
    ).map((e) => `${e.action}:${e.format ?? ''}`);

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    a1 = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id };
    b1 = { operatorId: f.operatorB, orgId: f.orgB, managerId: f.users.managerB1.id };
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('文章导出 Word：有标题、正文、固定提示和署名（健管师、协会、由 Health Buddy 辅助生成），记一条导出记录', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insert(a1, ARTICLE);
    const res = await exportAs(m, id, 'docx').expect(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    expect(decodeURIComponent(res.headers['content-disposition'] ?? '')).toMatch(
      /科普文章 \d{4}-\d{2}-\d{2} 第1版\.docx/,
    );
    const xml = readZipEntry(res.body as Buffer, 'word/document.xml')!;
    const names = await owner
      .selectFrom('users')
      .innerJoin('operators', 'operators.id', 'users.operator_id')
      .select(['users.display_name', 'operators.name'])
      .where('users.id', '=', f.users.managerA1.id)
      .executeTakeFirstOrThrow();
    for (const text of [
      '冬季怎样管理血压',
      '出门注意保暖',
      '仅供参考，非医疗诊断',
      '如有不适请及时就医',
      names.display_name,
      names.name,
      '由 Health Buddy 辅助生成',
    ]) {
      expect(xml).toContain(text);
    }
    expect(await formatsOf(id)).toEqual(['exported:docx']);
  });

  it('文章导出 PDF；PPT 导出 PPTX（讲稿在备注里，最后一页是固定提示）', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const article = await insert(a1, ARTICLE);
    const pdf = await exportAs(m, article, 'pdf').expect(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const deck = await insert(a1, DECK);
    const pptx = await exportAs(m, deck, 'pptx').expect(200);
    expect(pptx.headers['content-type']).toContain('presentationml');
    const body = pptx.body as Buffer;
    expect(readZipEntry(body, 'ppt/slides/slide2.xml')).toContain('出门戴帽子');
    expect(readZipEntry(body, 'ppt/slides/slide3.xml')).toContain('仅供参考，非医疗诊断');
    expect(readZipEntry(body, 'ppt/notesSlides/notesSlide2.xml')).toContain('合成讲稿');
    expect(await formatsOf(deck)).toEqual(['exported:pptx']);
  });

  it('复制：文章和社群稿返回纯文本，末尾有固定提示和署名；PPT 不能复制', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const post = await insert(a1, POST);
    const res = await m.post(`/api/artifacts/${post}/copy`).expect(200);
    const text = res.body.text as string;
    expect(text).toContain('今天聊聊冬季睡眠。');
    expect(text).toMatch(/仅供参考，非医疗诊断\n如有不适请及时就医\n\n.*由 Health Buddy 辅助生成$/);
    expect(await formatsOf(post)).toEqual(['copied:']);
    const deck = await insert(a1, DECK);
    expect((await m.post(`/api/artifacts/${deck}/copy`)).status).toBe(409);
  });

  it('草稿不能复制和导出；类型不允许的格式（社群稿导出、PPT 导出 Word、科普导出图片）返回 409', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const draft = await insert(a1, ARTICLE, 'draft');
    expect((await exportAs(m, draft, 'docx')).status).toBe(409);
    expect((await m.post(`/api/artifacts/${draft}/copy`)).status).toBe(409);
    const post = await insert(a1, POST);
    const deck = await insert(a1, DECK);
    const article = await insert(a1, ARTICLE);
    for (const [id, format] of [
      [post, 'pdf'],
      [deck, 'docx'],
      [article, 'png'],
      [article, 'pptx'],
    ] as const) {
      const res = await exportAs(m, id, format);
      expect(res.status, `${format}`).toBe(409);
    }
    expect(await formatsOf(article)).toEqual([]);
  });

  it('已审核后规则收紧、内容出现禁止类时不交付', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insert(a1, { ...ARTICLE, summary: '坚持就能治愈。' });
    const res = await m.post(`/api/artifacts/${id}/copy`);
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['content_check_failed']);
  });

  it('验收 13：别人的科普产物导出、复制一律 404；套餐关闭“科普内容工厂”返回 403', async () => {
    const theirs = await insert(b1, ARTICLE);
    for (const email of [f.users.managerA1.email, f.users.managerA2.email]) {
      const m = await loginAs(app, email);
      expect((await exportAs(m, theirs, 'docx')).status).toBe(404);
      expect((await m.post(`/api/artifacts/${theirs}/copy`)).status).toBe(404);
    }
    expect(await formatsOf(theirs)).toEqual([]);

    const plan = await owner
      .insertInto('plans')
      .values({
        code: 'no-content',
        name: '无科普',
        features: JSON.stringify({
          experts: true,
          twin: true,
          care: true,
          companion: true,
          content: false,
        }),
        monthly_quotas: JSON.stringify({
          llm_calls: null,
          expert_calls: null,
          report_pages: null,
          companion_devices: null,
        }),
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    const planId = (plan as { id: string }).id;
    await owner
      .insertInto('operator_plans')
      .values({ operator_id: f.operatorA, plan_id: planId } as never)
      .execute();
    await owner
      .insertInto('user_plans')
      .values({ user_id: f.users.managerA1.id, plan_id: planId } as never)
      .execute();
    const m = await loginAs(app, f.users.managerA1.email);
    const mine = await insert(a1, ARTICLE);
    const res = await exportAs(m, mine, 'docx');
    expect(res.status).toBe(403);
  });
});
