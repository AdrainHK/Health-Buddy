import type { INestApplication } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ExpertProvider, parseSse } from './expert-fixtures.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M6 第 6b-1 步：/转交回复（规格 2.4、2.9，验收 5、25）。@ 一个未处理的伴侣转交，AI 起草念给客户听的回复；
 * 草稿须审核，审核通过后点“发送”才交给福宝（后端 409）。转交必须是任务关联客户的、本人的未处理转交，
 * 跨租户一律 404，不调用模型。全部是合成数据。
 */
describe('/转交回复', () => {
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
  const handoffOf = (id: string) =>
    owner
      .selectFrom('companion_handoffs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  /** 用所有者身份写一条福宝的转交（福宝那边已经去掉电话、证件号） */
  const addHandoff = async (clientId: string, question: string, category = 'medication') => {
    const c = await owner
      .selectFrom('clients')
      .select(['operator_id', 'org_id', 'manager_id'])
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    const row = await owner
      .insertInto('companion_handoffs')
      .values({ ...c, client_id: clientId, category, question, trigger: 'rule' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  };

  const reply = (over: Record<string, unknown> = {}) => ({
    json: {
      reply: '您问的事我记下了，用药的事请向开药医生确认，我明天上午给您打电话细聊。',
      notes: ['客户问的是用药的事，请电话了解目前的用药情况'],
      crisisSignal: false,
      ...over,
    },
  });

  /** 生成草稿，返回产物 id */
  const draft = async (agent: Agent, clientId: string, handoffId: string) => {
    const task = await newTask(agent, { clientId });
    provider.scripts.skill = reply();
    const res = await send(agent, task, {
      mode: 'craft',
      content: '',
      skillId: 'handoff-reply',
      handoffRefs: [handoffId],
    });
    expect(res.status, res.text).toBe(200);
    const [artifact] = await artifactsOf(task);
    return { task, artifactId: artifact!.id as string };
  };
  const approve = async (agent: Agent, artifactId: string) => {
    const detail = (await agent.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact;
    return agent
      .post(`/api/artifacts/${artifactId}/approve`)
      .send({ version: detail.version, contentHash: detail.contentHash });
  };
  const sendReply = (agent: Agent, artifactId: string, body: Record<string, unknown> = {}) =>
    agent.post(`/api/artifacts/${artifactId}/send-handoff-reply`).send(body);

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

  it('@ 转交后生成：读伴侣信息，提示词里有原话、没有姓名和电话；草稿只有专业版，structured 带转交和回复', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(
      f.clients.a1[0],
      '测试客户 A1-1 问降压药能不能停，电话 13812345678',
    );
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply();
    const res = await send(a1, task, {
      mode: 'craft',
      content: '',
      skillId: 'handoff-reply',
      handoffRefs: [handoff],
    }).expect(200);
    expect(stepKinds(res.text)).toContain('read_companion');
    const text = prompt();
    expect(text).toContain('降压药能不能停');
    expect(text).toContain('类别：用药');
    expect(text).not.toContain('测试客户');
    expect(text).not.toContain('13812345678');
    const [artifact] = await artifactsOf(task);
    expect(artifact).toMatchObject({ kind: 'handoff_reply', status: 'draft' });
    expect(artifact!.structured).toEqual({
      handoffId: handoff,
      reply: '您问的事我记下了，用药的事请向开药医生确认，我明天上午给您打电话细聊。',
    });
    const content = artifact!.content as { professional: string; clientFacing: string };
    expect(content.clientFacing).toBe('');
    expect(content.professional).toContain('福宝会原样念给客户');
    // 消息记下 @ 的转交
    const messages = (await a1.get(`/api/tasks/${task}`).expect(200)).body.messages;
    expect(messages[0].handoffRefs).toEqual([handoff]);
  });

  it('没有 @ 转交：409 no_handoff；别的技能带转交、问一问带转交：400；都不调用模型', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(f.clients.a1[0], '合成：药能不能停');
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    const res = await send(a1, task, { mode: 'craft', content: '', skillId: 'handoff-reply' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('no_handoff');
    await send(a1, task, {
      mode: 'craft',
      content: '',
      skillId: 'visit-script',
      handoffRefs: [handoff],
    }).expect(400);
    await send(a1, task, { mode: 'ask', content: '问问', handoffRefs: [handoff] }).expect(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('输出检查不通过（药名、符号）重试一次；仍不过不保存草稿', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(f.clients.a1[0], '合成：二甲双胍能不能停');
    const task = await newTask(a1, { clientId: f.clients.a1[0] });
    provider.scripts.skill = reply({ reply: '二甲双胍先别停（每天两片）。' });
    await send(a1, task, {
      mode: 'craft',
      content: '',
      skillId: 'handoff-reply',
      handoffRefs: [handoff],
    }).expect(200);
    expect(provider.calls).toHaveLength(2);
    expect(await artifactsOf(task)).toHaveLength(0);
  });

  it('未审核不能发送（409）；改回复后审核、发送：转交变已回复，记下来源产物；不能再发', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(f.clients.a1[0], '合成：药能不能停');
    const { artifactId } = await draft(a1, f.clients.a1[0], handoff);
    const early = await sendReply(a1, artifactId);
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('not_approved');

    // 草稿上改回复：专业版跟着改；换转交 → 400
    const detail = (await a1.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact;
    const edited = '我记下了，用药的事请向开药医生确认，我明天给您打电话。';
    await a1
      .patch(`/api/artifacts/${artifactId}`)
      .send({
        version: detail.version,
        contentHash: detail.contentHash,
        content: detail.content,
        structured: { handoffId: await addHandoff(f.clients.a1[0], '合成：别的'), reply: edited },
      })
      .expect(400);
    const patched = await a1.patch(`/api/artifacts/${artifactId}`).send({
      version: detail.version,
      contentHash: detail.contentHash,
      content: detail.content,
      structured: { handoffId: handoff, reply: edited },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.body.artifact.content.professional).toContain(edited);

    expect((await approve(a1, artifactId)).status).toBe(200);
    const sent = await sendReply(a1, artifactId);
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body.events.map((e: { action: string }) => e.action)).toContain(
      'companion_reply_sent',
    );
    expect(await handoffOf(handoff)).toMatchObject({
      status: 'replied',
      reply_text: edited,
      reply_artifact_id: artifactId,
      replied_by: f.users.managerA1.id,
    });
    const again = await sendReply(a1, artifactId);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('handoff_closed');
  });

  it('审核：回复里有禁用词不能确认；发送：有药名提醒时不带确认 400，带确认成功', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(f.clients.a1[0], '合成：药能不能停');
    const { artifactId } = await draft(a1, f.clients.a1[0], handoff);
    const detail = (await a1.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact;
    const patch = async (text: string, d: { version: number; contentHash: string }) =>
      (
        await a1
          .patch(`/api/artifacts/${artifactId}`)
          .send({
            version: d.version,
            contentHash: d.contentHash,
            content: detail.content,
            structured: { handoffId: handoff, reply: text },
          })
          .expect(200)
      ).body.artifact;
    const banned = await patch('这个能根治。', detail);
    const rejected = await a1
      .post(`/api/artifacts/${artifactId}/approve`)
      .send({ version: banned.version, contentHash: banned.contentHash });
    expect(rejected.status).toBe(409);
    expect(rejected.body.reasons).toContain('banned_terms');

    await patch('降压药先别停，我明天给您打电话。', banned);
    expect((await approve(a1, artifactId)).status).toBe(200);
    const warned = await sendReply(a1, artifactId);
    expect(warned.status).toBe(400);
    expect(warned.body.reasons[0]).toBe('needs_confirmation');
    expect((await handoffOf(handoff)).status).toBe('open');
    await sendReply(a1, artifactId, { acknowledgeWarnings: true }).expect(200);
    expect((await handoffOf(handoff)).status).toBe('replied');
  });

  it('转交已被直接回复或关闭：发送 409 handoff_closed；退回重写也不再生成', async () => {
    const a1 = await as(f.users.managerA1.email);
    const handoff = await addHandoff(f.clients.a1[0], '合成：药能不能停');
    const { artifactId } = await draft(a1, f.clients.a1[0], handoff);
    expect((await approve(a1, artifactId)).status).toBe(200);
    await a1
      .post(`/api/companion/handoffs/${handoff}/close`)
      .send({ outcome: 'closed_by_call' })
      .expect(200);
    const res = await sendReply(a1, artifactId);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('handoff_closed');
    expect((await handoffOf(handoff)).reply_artifact_id).toBeNull();
  });

  it('数据库再核对：以应用角色直接写库，未审核的草稿、别的转交的草稿都不能记成回复来源', async () => {
    const a1 = await as(f.users.managerA1.email);
    const h1 = await addHandoff(f.clients.a1[0], '合成：一');
    const h2 = await addHandoff(f.clients.a1[0], '合成：二');
    const { artifactId } = await draft(a1, f.clients.a1[0], h1);
    const reply = '用药的事请向开药医生确认。';
    const appDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
    const ctx: TenantContext = {
      userId: f.users.managerA1.id,
      role: 'manager',
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    const write = (handoffId: string, text: string) =>
      withTenant(appDb, ctx, (trx) =>
        trx
          .updateTable('companion_handoffs')
          .set({ status: 'replied', reply_text: text, reply_artifact_id: artifactId })
          .where('id', '=', handoffId)
          .execute(),
      );
    try {
      // 草稿还没审核
      await expect(write(h1, reply)).rejects.toThrow(/approved draft/);
      await owner
        .updateTable('artifacts')
        .set({ status: 'approved' })
        .where('id', '=', artifactId)
        .execute();
      // 别的转交、原文不一致
      await expect(write(h2, reply)).rejects.toThrow(/approved draft/);
      const stored = (
        await owner
          .selectFrom('artifacts')
          .select('structured')
          .where('id', '=', artifactId)
          .executeTakeFirstOrThrow()
      ).structured as { reply: string };
      await expect(write(h1, `${stored.reply}改`)).rejects.toThrow(/approved draft/);
      await write(h1, stored.reply);
      expect((await handoffOf(h1)).reply_artifact_id).toBe(artifactId);
    } finally {
      await appDb.destroy();
    }
  });

  describe('跨租户：@ 和发送一律 404，不调用模型', () => {
    it('同机构、其他机构、其他协会的健管师 @ 别人的转交 → 404', async () => {
      const handoff = await addHandoff(f.clients.a1[0], '合成：药能不能停');
      for (const email of [
        f.users.managerA2.email,
        f.users.managerA3.email,
        f.users.managerB1.email,
      ]) {
        const agent = await as(email);
        const task = await newTask(agent);
        await send(agent, task, {
          mode: 'craft',
          content: '',
          skillId: 'handoff-reply',
          handoffRefs: [handoff],
        }).expect(404);
      }
      // 自己任务的客户不是转交的客户 → 404
      const a1 = await as(f.users.managerA1.email);
      const task = await newTask(a1, { clientId: f.clients.a1[1] });
      await send(a1, task, {
        mode: 'craft',
        content: '',
        skillId: 'handoff-reply',
        handoffRefs: [handoff],
      }).expect(404);
      // 已关闭的转交 → 404
      await a1
        .post(`/api/companion/handoffs/${handoff}/close`)
        .send({ outcome: 'closed' })
        .expect(200);
      const own = await newTask(a1, { clientId: f.clients.a1[0] });
      await send(a1, own, {
        mode: 'craft',
        content: '',
        skillId: 'handoff-reply',
        handoffRefs: [handoff],
      }).expect(404);
      expect(provider.calls).toHaveLength(0);
    });

    it('别人发送一律 404；客户转出后原健管师 409 只读、草稿里没有原话，新健管师可以 @ 起草', async () => {
      const a1 = await as(f.users.managerA1.email);
      const handoff = await addHandoff(f.clients.a1[0], '合成：降压药能不能停');
      const { artifactId } = await draft(a1, f.clients.a1[0], handoff);
      expect((await approve(a1, artifactId)).status).toBe(200);
      for (const email of [
        f.users.managerA2.email,
        f.users.managerA3.email,
        f.users.managerB1.email,
        f.users.orgAdminA.email,
        f.users.operatorAdminA.email,
        f.users.platform.email,
      ]) {
        const agent = await as(email);
        const res = await sendReply(agent, artifactId, { acknowledgeWarnings: true });
        expect(res.status, email).toBe(404);
      }
      expect((await handoffOf(handoff)).status).toBe('open');

      // 客户转给 A2：转交跟着客户走，原健管师的草稿只读，发不出去，也看不到原话
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      const after = await sendReply(a1, artifactId, { acknowledgeWarnings: true });
      expect(after.status).toBe(409);
      expect(after.body.reasons).toContain('read_only');
      expect((await handoffOf(handoff)).status).toBe('open');
      const old = (await a1.get(`/api/artifacts/${artifactId}`).expect(200)).body.artifact;
      expect(JSON.stringify(old)).not.toContain('降压药能不能停');
      // 原健管师任务里 @ 的转交被置空
      const refs = await owner
        .selectFrom('task_messages')
        .select('handoff_ref')
        .where('handoff_ref', 'is not', null)
        .execute();
      expect(refs).toHaveLength(0);

      // 新健管师 A2 可以 @ 这个转交起草、审核、发送
      const a2 = await as(f.users.managerA2.email);
      const { artifactId: mine } = await draft(a2, f.clients.a1[0], handoff);
      expect((await approve(a2, mine)).status).toBe(200);
      await sendReply(a2, mine).expect(200);
      expect(await handoffOf(handoff)).toMatchObject({
        status: 'replied',
        replied_by: f.users.managerA2.id,
        reply_artifact_id: mine,
      });
    });
  });
});
