import { DEFAULT_VISIT_FREQUENCY_RULES, scheduleVisits } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M5 第 5 步：/随访计划（规格 2.7、5.2、Q17）。日期由后端按频次规则算，模型只写方式和重点；
 * 结构和输入对不上时重试一次，仍不合格不保存草稿。跨租户一律 404，不调用模型。全部是合成数据。
 */
describe('/随访计划', () => {
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

  /** 按默认规则、高风险、没有方案和跟进项算出的日期（和后端同一个纯函数） */
  const expected = () =>
    scheduleVisits({
      now: new Date(),
      timeZone: 'Asia/Shanghai',
      riskTier: 'high',
      rules: DEFAULT_VISIT_FREQUENCY_RULES,
      planReviewDate: null,
      hasUrgentFollowUp: false,
    }).visits;
  const reply = (rows = expected()) => ({
    json: {
      rows: rows.map((r) => ({ ...r, focus: '了解近期饮食和散步的执行情况' })),
      notes: [],
      crisisSignal: false,
    },
  });

  beforeAll(async () => {
    app = await createTestApp({}, { llmProviders: { openai: provider } });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    provider.reset();
    const a1 = await as(f.users.managerA1.email);
    await a1
      .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
      .send({ tier: 'high', reason: '合成理由' })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('生成草稿：读档案、孪生和当前方案后排日期；日期照抄后端算的；提示词没有姓名', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply();
    const res = await send(a1, task, {
      mode: 'craft',
      content: '测试客户 A1-1 最近在调整晚饭',
      skillId: 'visit-schedule',
    }).expect(200);
    expect(stepKinds(res.text)).toEqual([
      'read_client',
      'read_twin',
      'read_care_plan',
      'schedule_visits',
      'detect_critical',
      'run_skill',
    ]);
    const [artifact] = await artifactsOf(task);
    expect(artifact).toMatchObject({ kind: 'visit_schedule', status: 'draft' });
    const rows = (artifact!.structured as { rows: { dueDate: string; purpose: string }[] }).rows;
    expect(rows.map((r) => [r.dueDate, r.purpose])).toEqual(
      expected().map((r) => [r.dueDate, r.purpose]),
    );
    expect((artifact!.content as { clientFacing: string }).clientFacing).toBe('');
    const prompt = JSON.stringify(provider.calls.at(-1)!.messages);
    expect(prompt).toContain('系统排好的随访日期');
    expect(prompt).toContain('“高”的间隔 14 天');
    expect(prompt).not.toContain('测试客户');

    // 确认后写入随访日程
    const detail = (await a1.get(`/api/artifacts/${artifact!.id}`).expect(200)).body.artifact;
    await a1
      .post(`/api/artifacts/${artifact!.id}/approve`)
      .send({ version: detail.version, contentHash: detail.contentHash })
      .expect(200);
    const visits = await owner
      .selectFrom('visits')
      .select(['status', 'origin'])
      .where('source_artifact_id', '=', artifact!.id)
      .execute();
    expect(visits).toHaveLength(expected().length);
    expect(visits.every((v) => v.status === 'planned' && v.origin === 'schedule')).toBe(true);
  });

  it('模型改了日期：带纠正说明重试一次；仍对不上就不保存草稿', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const wrong = expected().map((r, i) => (i === 0 ? { ...r, dueDate: '2020-01-01' } : r));
    provider.scripts.skill = [reply(wrong), reply()];
    await send(a1, task, { mode: 'craft', content: '', skillId: 'visit-schedule' }).expect(200);
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain('必须逐行照抄日期和目的类别');
    expect(await artifactsOf(task)).toHaveLength(1);

    const again = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.reset();
    provider.scripts.skill = reply(wrong);
    const res = await send(a1, again, {
      mode: 'craft',
      content: '',
      skillId: 'visit-schedule',
    }).expect(200);
    expect(provider.calls).toHaveLength(2);
    expect(res.text).toContain('wording_check_failed');
    expect(await artifactsOf(again)).toHaveLength(0);
  });

  it('跨租户访问被拒绝：别人的任务、别人的客户 → 404，不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    for (const u of [f.users.managerA2, f.users.managerB1]) {
      const other = await as(u.email);
      await send(other, task, { mode: 'craft', content: '', skillId: 'visit-schedule' }).expect(
        404,
      );
    }
    for (const other of [f.clients.a2, f.clients.b1]) {
      const t = await newTask(a1);
      await send(a1, t, {
        mode: 'craft',
        content: '',
        skillId: 'visit-schedule',
        clientRefs: [other],
      }).expect(404);
    }
    expect(provider.calls).toHaveLength(0);
  });
});
