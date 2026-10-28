import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M5 第 6 步：/随访话术、/随访记录（规格 2.8、2.9、5.4）。素材解密后去标识才进提示词，
 * 素材和随访都要是任务关联客户的、本人上传的；没有素材时 409 no_materials。跨租户一律 404，
 * 不调用模型。全部是合成数据。
 */
describe('/随访话术、/随访记录', () => {
  const owner = ownerDb();
  const provider = new ExpertProvider();
  let app: INestApplication;
  let f: Fixtures;

  const as = (email: string) => loginAs(app, email);
  const newTask = async (agent: Agent, body: Record<string, unknown> = {}) =>
    (await agent.post('/api/tasks').send(body).expect(201)).body.task.id as string;
  const send = (agent: Agent, taskId: string, body: Record<string, unknown>) =>
    agent.post(`/api/tasks/${taskId}/messages`).send(body);
  const artifactsOf = (taskId: string) =>
    owner.selectFrom('artifacts').selectAll().where('task_id', '=', taskId).execute();
  const stepKinds = (text: string) =>
    parseSse(text).flatMap((e) =>
      e.type === 'step' && e.step.status === 'running' ? [e.step.kind] : [],
    );
  const prompt = () => JSON.stringify(provider.calls.at(-1)!.messages);
  const upload = async (agent: Agent, clientId: string, text: string, visitId?: string) =>
    (
      await agent
        .post(`/api/clients/${clientId}/visit-materials`)
        .send({ text, consentConfirmed: true, ...(visitId ? { visitId } : {}) })
        .expect(201)
    ).body.material.id as string;
  const addVisit = async (agent: Agent, clientId: string, focus: string) =>
    (
      await agent
        .post(`/api/clients/${clientId}/visits`)
        .send({ dueDate: tomorrow(), method: 'phone', focus })
        .expect(201)
    ).body.visit.id as string;
  const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const yesterday = () => new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

  const scriptReply = {
    json: {
      summary: { changes: [], adherence: [], followUps: [], agreements: [] },
      opening: '您好，今天想和您聊聊最近散步的情况。',
      questions: [
        { section: 'exercise', question: '这周有没有出去走一走？', why: '上次约定散步' },
        { section: 'exercise', question: '一般走多久？', why: '了解执行情况' },
        { section: 'diet', question: '晚饭一般吃些什么？', why: '了解饮食' },
      ],
      encouragement: ['坚持散步很不容易。'],
      adjustments: [],
      reminders: [],
      notes: [],
      crisisSignal: false,
    },
  };
  const recordReply = (over: Record<string, unknown> = {}) => ({
    json: {
      visitDate: yesterday(),
      method: 'phone',
      summary: '电话随访，客户说晚饭后散步。',
      feedback: [{ topic: 'exercise', items: ['客户说晚饭后散步 20 分钟'] }],
      planProgress: [],
      agreements: ['周末也散步'],
      attentionPoints: [],
      historySuggestions: [],
      openQuestions: [],
      notes: [],
      crisisSignal: false,
      ...over,
    },
  });

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

  describe('/随访话术', () => {
    it('读档案、孪生、当前方案、随访记录后生成；提示词里有下一次随访的重点、没有姓名；只有专业版', async () => {
      const a1 = await as(f.users.managerA1.email);
      await addVisit(a1, f.clients.a1[0], '了解周末散步的情况');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      provider.scripts.skill = scriptReply;
      const res = await send(a1, task, {
        mode: 'craft',
        content: '测试客户 A1-1 最近在调整晚饭',
        skillId: 'visit-script',
      }).expect(200);
      expect(stepKinds(res.text)).toEqual([
        'read_client',
        'read_twin',
        'read_care_plan',
        'read_visit_records',
        'detect_critical',
        'run_skill',
      ]);
      expect(prompt()).toContain('了解周末散步的情况');
      expect(prompt()).not.toContain('测试客户');
      const [artifact] = await artifactsOf(task);
      expect(artifact).toMatchObject({ kind: 'visit_script', status: 'draft' });
      const content = artifact!.content as { professional: string; clientFacing: string };
      expect(content.clientFacing).toBe('');
      expect(content.professional).toContain('伴侣对话要点（M6 接入）');
    });

    it('关联的随访：用那一次的重点，草稿记下关联；别的客户的随访 → 404，不调用模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const visit = await addVisit(a1, f.clients.a1[0], '复评晚饭调整');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      provider.scripts.skill = scriptReply;
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-script',
        visitId: visit,
      }).expect(200);
      expect(prompt()).toContain('复评晚饭调整');
      expect((await artifactsOf(task))[0]).toMatchObject({ visit_id: visit });

      provider.reset();
      const other = await addVisit(a1, f.clients.a1[1], '别的客户');
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-script',
        visitId: other,
      }).expect(404);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('/随访记录', () => {
    it('没有素材：409 no_materials；别的技能带素材：400；都不调用模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      const res = await send(a1, task, { mode: 'craft', content: '', skillId: 'visit-record' });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('no_materials');
      const material = await upload(a1, f.clients.a1[0], '合成通话笔记');
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-script',
        materialRefs: [material],
      }).expect(400);
      expect(provider.calls).toHaveLength(0);
    });

    it('素材解密后去标识（客户姓名、电话）；草稿记下素材和随访；确认后随访完成、素材 30 天后清理', async () => {
      const a1 = await as(f.users.managerA1.email);
      const visit = await addVisit(a1, f.clients.a1[0], '了解散步');
      const material = await upload(
        a1,
        f.clients.a1[0],
        '测试客户 A1-1（电话 13812345678）说晚饭后散步 20 分钟。',
        visit,
      );
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      provider.scripts.skill = recordReply();
      const res = await send(a1, task, {
        mode: 'craft',
        content: '这是电话随访',
        skillId: 'visit-record',
        materialRefs: [material],
        visitId: visit,
      }).expect(200);
      expect(stepKinds(res.text)).toEqual([
        'read_visit_materials',
        'read_client',
        'read_care_plan',
        'detect_critical',
        'run_skill',
      ]);
      const text = prompt();
      expect(text).toContain('晚饭后散步 20 分钟');
      expect(text).not.toContain('测试客户');
      expect(text).not.toContain('13812345678');

      const [artifact] = await artifactsOf(task);
      expect(artifact).toMatchObject({
        kind: 'visit_record',
        visit_id: visit,
        material_ids: [material],
      });
      expect(artifact!.structured).toMatchObject({ method: 'phone', agreements: ['周末也散步'] });

      const detail = (await a1.get(`/api/artifacts/${artifact!.id}`).expect(200)).body.artifact;
      const approved = await a1
        .post(`/api/artifacts/${artifact!.id}/approve`)
        .send({ version: detail.version, contentHash: detail.contentHash });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const v = await owner
        .selectFrom('visits')
        .select('status')
        .where('id', '=', visit)
        .executeTakeFirstOrThrow();
      expect(v.status).toBe('done');
      const m = await owner
        .selectFrom('visit_materials')
        .select(['consumed_artifact_id', 'purge_after'])
        .where('id', '=', material)
        .executeTakeFirstOrThrow();
      expect(m.consumed_artifact_id).toBe(artifact!.id);
      expect(m.purge_after).not.toBeNull();
    });

    it('素材里有危机描述：关键词识别，置顶危机提示', async () => {
      const a1 = await as(f.users.managerA1.email);
      const material = await upload(a1, f.clients.a1[0], '客户说最近觉得活着没意思。');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      provider.scripts.skill = recordReply();
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-record',
        materialRefs: [material],
      }).expect(200);
      const [artifact] = await artifactsOf(task);
      expect(artifact).toMatchObject({ crisis_signal: true });
      expect((artifact!.content as { professional: string }).professional).toContain(
        '心理危机提示',
      );
    });

    it('只有模型标出危机信号（素材里没有关键词）：草稿同样标为危机，审核栏醒目提示', async () => {
      const a1 = await as(f.users.managerA1.email);
      const material = await upload(a1, f.clients.a1[0], '合成通话笔记：客户说最近不太想见人。');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      provider.scripts.skill = recordReply({ crisisSignal: true });
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-record',
        materialRefs: [material],
      }).expect(200);
      expect((await artifactsOf(task))[0]).toMatchObject({ crisis_signal: true });
    });

    it('跨租户访问被拒绝：别的健管师、别的运营商的随访，已清理的素材，别的租户 @ 本人素材 → 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      const a2 = await as(f.users.managerA2.email);
      const b1 = await as(f.users.managerB1.email);
      const mine = await upload(a1, f.clients.a1[0], '合成通话笔记');
      const purged = await upload(a1, f.clients.a1[0], '合成通话笔记');
      await owner
        .updateTable('visit_materials')
        .set({ purged_at: new Date(), text_encrypted: null })
        .where('id', '=', purged)
        .execute();
      const a2Visit = await addVisit(a2, f.clients.a2, '别人的随访');
      const b1Visit = await addVisit(b1, f.clients.b1, '别的运营商的随访');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      for (const visitId of [a2Visit, b1Visit]) {
        await send(a1, task, {
          mode: 'craft',
          content: '',
          skillId: 'visit-script',
          visitId,
        }).expect(404);
      }
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-record',
        materialRefs: [purged],
      }).expect(404);
      const b1Task = await newTask(b1, { clientId: f.clients.b1 });
      await send(b1, b1Task, {
        mode: 'craft',
        content: '',
        skillId: 'visit-record',
        materialRefs: [mine],
      }).expect(404);
      expect(provider.calls).toHaveLength(0);
    });

    it('跨租户访问被拒绝：别人的素材、别的客户的素材、别人的任务 → 404，不调用模型', async () => {
      const a1 = await as(f.users.managerA1.email);
      const a2 = await as(f.users.managerA2.email);
      const b1 = await as(f.users.managerB1.email);
      const mine = await upload(a1, f.clients.a1[0], '合成通话笔记');
      const otherClient = await upload(a1, f.clients.a1[1], '合成通话笔记');
      const othersMaterial = await upload(a2, f.clients.a2, '合成通话笔记');
      const task = await newTask(a1, { clientId: f.clients.a1[0] });
      for (const ref of [otherClient, othersMaterial]) {
        await send(a1, task, {
          mode: 'craft',
          content: '',
          skillId: 'visit-record',
          materialRefs: [ref],
        }).expect(404);
      }
      for (const other of [a2, b1]) {
        await send(other, task, {
          mode: 'craft',
          content: '',
          skillId: 'visit-record',
          materialRefs: [mine],
        }).expect(404);
      }
      expect(provider.calls).toHaveLength(0);
      expect(await artifactsOf(task)).toHaveLength(0);
    });
  });
});
