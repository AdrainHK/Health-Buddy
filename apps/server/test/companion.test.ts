import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localDate } from '../src/twin/time-zone.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/** 同意和撤回日期：不能早于告知书发布日期（测试里告知书都是今天发布的） */
const TODAY = localDate(new Date(), 'Asia/Shanghai');
/**
 * M6 第 1 步：伴侣设备、线下同意、伴侣设置、平台批次和固定话术的接口（规格 2.1、2.8、2.10、6.4）。
 * 每个接口都有跨租户被拒绝的用例。全部是合成数据，序列号、密钥、激活码都是测试值。
 */
describe('伴侣设备和设置接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;

  const as = (email: string) => loginAs(app, email);
  const secret = () => randomBytes(32).toString('hex');
  const devices = [
    { serialNo: 'HB-TEST-0001', deviceSecret: secret(), activationCode: 'ABCD1234' },
    { serialNo: 'HB-TEST-0002', deviceSecret: secret(), activationCode: 'EFGH5678' },
  ];

  let platform: Agent;
  let a1: Agent;
  const base = () => `/api/clients/${f.clients.a1[0]}/companion`;

  const importBatch = () =>
    platform
      .post('/api/admin/companion/device-batches')
      .send({ name: '测试批次', devices })
      .expect(201);
  const publishNotice = () =>
    platform
      .put('/api/admin/companion/scripts/notice')
      .send({ text: '测试用告知书：福宝不是医生，可以随时撤回同意。' })
      .expect(200);
  const consent = (agent: Agent, url = base()) =>
    agent
      .post(`${url}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true });

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });
  beforeEach(async () => {
    f = await seedFixtures(owner);
    platform = await as(f.users.platform.email);
    a1 = await as(f.users.managerA1.email);
  });

  it('概览：未绑定时的默认设置；别人的客户和非健管师都是 404', async () => {
    const res = await a1.get(base()).expect(200);
    expect(res.body).toEqual({
      status: 'unbound',
      device: null,
      consent: null,
      settings: { nameForClient: null, voiceSpeed: 'slow', volume: 'medium' },
      currentNoticeVersion: null,
    });
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
      f.users.platform.email,
    ]) {
      const agent = await as(email);
      await agent.get(base()).expect(404);
      await agent.patch(base()).send({ volume: 'high' }).expect(404);
      await consent(agent).expect(404);
      await agent
        .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
        .send({ revokedOn: TODAY })
        .expect(404);
      await agent
        .post(`${base()}/device`)
        .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
        .expect(404);
      await agent.delete(`${base()}/device`).expect(404);
      await agent.post(`${base()}/pause`).expect(404);
      await agent.post(`${base()}/resume`).expect(404);
    }
    await a1.get('/api/clients/not-a-uuid/companion').expect(404);
  });

  it('已绑定设备时，别人调用每个接口都 404，设备和同意记录不变；同机构的健管师拿到激活码也绑不走', async () => {
    await importBatch();
    await publishNotice();
    await consent(a1).expect(200);
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(200);
    const snapshot = async () => ({
      device: await owner
        .selectFrom('companion_devices')
        .select(['status', 'client_id', 'manager_id'])
        .where('serial_no', '=', 'HB-TEST-0001')
        .executeTakeFirstOrThrow(),
      consents: (
        await owner
          .selectFrom('companion_consents')
          .select('id')
          .where('client_id', '=', f.clients.a1[0])
          .execute()
      ).length,
      settings: await owner
        .selectFrom('clients')
        .select(['companion_volume', 'companion_name_for_client'])
        .where('id', '=', f.clients.a1[0])
        .executeTakeFirstOrThrow(),
    });
    const before = await snapshot();
    for (const email of [
      f.users.managerA2.email,
      f.users.managerA3.email,
      f.users.managerB1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
      f.users.platform.email,
    ]) {
      const agent = await as(email);
      await agent.get(base()).expect(404);
      await agent.patch(base()).send({ volume: 'high', nameForClient: '别人' }).expect(404);
      await consent(agent).expect(404);
      await agent
        .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
        .send({ revokedOn: TODAY })
        .expect(404);
      await agent.delete(`${base()}/device`).expect(404);
      await agent.post(`${base()}/pause`).expect(404);
      await agent.post(`${base()}/resume`).expect(404);
    }
    expect(await snapshot()).toEqual(before);

    // 同机构的 A2 给自己的客户绑 A1 已绑的设备：和激活码错一样只说“不可用”
    const a2 = await as(f.users.managerA2.email);
    const a2Url = `/api/clients/${f.clients.a2}/companion`;
    await consent(a2, a2Url).expect(200);
    await a2
      .post(`${a2Url}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(409)
      .expect((r) =>
        expect(r.body).toEqual({ error: 'conflict', reasons: ['device_unavailable'] }),
      );
    expect(await snapshot()).toEqual(before);
  });

  it('客户转给别的机构的健管师：原健管师 404，新健管师看到设备和同意记录', async () => {
    await importBatch();
    await publishNotice();
    await consent(a1).expect(200);
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(200);
    await owner
      .updateTable('clients')
      .set({ manager_id: f.users.managerA3.id, org_id: f.orgA2 })
      .where('id', '=', f.clients.a1[0])
      .execute();
    await a1.get(base()).expect(404);
    const a3 = await as(f.users.managerA3.email);
    const res = await a3.get(base()).expect(200);
    expect(res.body).toMatchObject({
      status: 'pending_activation',
      device: { serialLast4: '0001' },
      consent: { noticeVersion: 1, revokedOn: null },
    });
  });

  it('设置：称呼、语速、音量；称呼超过 10 个字 400', async () => {
    const res = await a1
      .patch(base())
      .send({ nameForClient: '王阿姨', voiceSpeed: 'medium' })
      .expect(200);
    expect(res.body.settings).toEqual({
      nameForClient: '王阿姨',
      voiceSpeed: 'medium',
      volume: 'medium',
    });
    await a1.patch(base()).send({ nameForClient: '一二三四五六七八九十一' }).expect(400);
    await a1.patch(base()).send({}).expect(400);
    await a1.patch(base()).send({ volume: 'loud' }).expect(400);
  });

  it('同意：要勾选、版本要存在、日期不能晚于今天；撤回前要有同意', async () => {
    await consent(a1).expect(400); // 还没有告知书模板
    await publishNotice();
    await a1
      .post(`${base()}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY })
      .expect(400);
    await a1
      .post(`${base()}/consents?tz=Asia/Shanghai`)
      .send({
        noticeVersion: 1,
        consentedOn: '2999-01-01',
        confirmed: true,
        chatDataConfirmed: true,
      })
      .expect(400);
    await a1
      .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(409);
    const res = await consent(a1).expect(200);
    expect(res.body.consent).toMatchObject({
      noticeVersion: 1,
      consentedOn: TODAY,
      revokedOn: null,
    });
    expect(res.body.currentNoticeVersion).toBe(1);
    const revoked = await a1
      .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    expect(revoked.body.consent).toMatchObject({ revokedOn: TODAY });
  });

  it('绑定：激活码不对、序列号不存在、已被别人绑定，都只说“不可用”；不能绑两台', async () => {
    await importBatch();
    await publishNotice();
    const bind = (agent: Agent, body: object, url = base()) =>
      agent.post(`${url}/device`).send(body);
    await bind(a1, { serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ reasons: ['no_consent'] }));
    await consent(a1).expect(200);
    await bind(a1, { serialNo: 'HB-TEST-0001', activationCode: 'WRONG999' })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ reasons: ['device_unavailable'] }));
    await bind(a1, { serialNo: 'HB-NOPE-9999', activationCode: 'ABCD1234' })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ reasons: ['device_unavailable'] }));
    // 激活码录入时允许空格、连字符和小写
    const ok = await bind(a1, { serialNo: 'HB-TEST-0001', activationCode: 'abcd-1234' }).expect(
      200,
    );
    expect(ok.body.status).toBe('pending_activation');
    expect(ok.body.device).toMatchObject({ serialLast4: '0001', status: 'bound', online: false });
    expect(JSON.stringify(ok.body)).not.toContain('HB-TEST-0001');
    await bind(a1, { serialNo: 'HB-TEST-0002', activationCode: 'EFGH5678' })
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ reasons: ['already_bound'] }));

    // 别的协会的健管师拿到序列号和激活码也绑不上，响应和激活码错一样
    const b1 = await as(f.users.managerB1.email);
    const bUrl = `/api/clients/${f.clients.b1}/companion`;
    await consent(b1, bUrl).expect(200);
    await bind(b1, { serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' }, bUrl)
      .expect(409)
      .expect((r) =>
        expect(r.body).toEqual({ error: 'conflict', reasons: ['device_unavailable'] }),
      );
  });

  it('绑定失败太多次 429', async () => {
    await importBatch();
    await publishNotice();
    await consent(a1).expect(200);
    for (let i = 0; i < 10; i++) {
      await a1
        .post(`${base()}/device`)
        .send({ serialNo: 'HB-TEST-0001', activationCode: `WRONG00${i}` })
        .expect(409);
    }
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(429);
  });

  it('同意：必须单独确认聊天数据的使用；只能按当前告知书版本；撤回日期不早于同意日期', async () => {
    await publishNotice();
    await a1
      .post(`${base()}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 1, consentedOn: TODAY, confirmed: true })
      .expect(400);
    await platform
      .put('/api/admin/companion/scripts/notice')
      .send({ text: '测试用告知书第二版：福宝不是医生，可以随时撤回同意。' })
      .expect(200);
    await consent(a1).expect(400); // 第 1 版已不是当前版本
    await a1
      .post(`${base()}/consents?tz=Asia/Shanghai`)
      .send({ noticeVersion: 2, consentedOn: TODAY, confirmed: true, chatDataConfirmed: true })
      .expect(200);
    await a1
      .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: '2026-01-01' })
      .expect(400);
    const row = await owner
      .selectFrom('companion_consents')
      .select(['notice_version', 'chat_data_confirmed'])
      .where('client_id', '=', f.clients.a1[0])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ notice_version: 2, chat_data_confirmed: true });
  });

  it('撤回同意后重新同意：设备回到撤回前的状态（暂停的仍是暂停）', async () => {
    await importBatch();
    await publishNotice();
    await consent(a1).expect(200);
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(200);
    await a1.post(`${base()}/pause`).expect(200);
    await a1
      .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    expect((await a1.get(base()).expect(200)).body.status).toBe('revoked');
    expect((await consent(a1).expect(200)).body.status).toBe('paused');
  });

  it('暂停、恢复、解绑；撤回同意后设备只播暂停话术，不能恢复', async () => {
    await importBatch();
    await publishNotice();
    await consent(a1).expect(200);
    await a1.post(`${base()}/pause`).expect(409);
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0001', activationCode: 'ABCD1234' })
      .expect(200);
    expect((await a1.post(`${base()}/pause`).expect(200)).body.status).toBe('paused');
    expect((await a1.post(`${base()}/resume`).expect(200)).body.status).toBe('pending_activation');
    await a1
      .post(`${base()}/consents/revoke?tz=Asia/Shanghai`)
      .send({ revokedOn: TODAY })
      .expect(200);
    expect((await a1.get(base()).expect(200)).body.status).toBe('revoked');
    await a1.post(`${base()}/resume`).expect(409);
    expect((await a1.delete(`${base()}/device`).expect(200)).body.status).toBe('unbound');
    await a1.delete(`${base()}/device`).expect(409);
  });

  it('告知书模板：健管师能取当前版本打印；没有时 404；其他角色 404', async () => {
    await a1.get('/api/companion/notice').expect(404);
    await publishNotice();
    const res = await a1.get('/api/companion/notice').expect(200);
    expect(res.body).toMatchObject({
      kind: 'notice',
      version: 1,
      text: '测试用告知书：福宝不是医生，可以随时撤回同意。',
    });
    await (await as(f.users.orgAdminA.email)).get('/api/companion/notice').expect(404);
  });

  it('平台批次：只有平台管理员；重复序列号 409 且整批不导入；统计不含客户', async () => {
    for (const email of [
      f.users.managerA1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
    ]) {
      const agent = await as(email);
      await agent.get('/api/admin/companion/device-batches').expect(403);
      await agent
        .post('/api/admin/companion/device-batches')
        .send({ name: 'x', devices })
        .expect(403);
    }
    const created = await importBatch();
    expect(created.body).toMatchObject({ name: '测试批次', deviceCount: 2, boundCount: 0 });
    const dup = await platform
      .post('/api/admin/companion/device-batches')
      .send({
        name: '第二批',
        devices: [
          devices[0],
          { serialNo: 'HB-TEST-0003', deviceSecret: secret(), activationCode: 'IJKL9012' },
        ],
      })
      .expect(409);
    expect(dup.body).toMatchObject({ reasons: ['duplicate_serials'], serials: ['HB-TEST-0001'] });
    await platform
      .post('/api/admin/companion/device-batches')
      .send({ name: '同批重复', devices: [devices[0], devices[0]] })
      .expect(400);
    await publishNotice();
    await consent(a1).expect(200);
    await a1
      .post(`${base()}/device`)
      .send({ serialNo: 'HB-TEST-0002', activationCode: 'EFGH5678' })
      .expect(200);
    const list = await platform.get('/api/admin/companion/device-batches').expect(200);
    expect(list.body.batches).toEqual([expect.objectContaining({ deviceCount: 2, boundCount: 1 })]);
    expect(JSON.stringify(list.body)).not.toContain(f.clients.a1[0]);
    // 数据库里只存哈希
    const row = await owner
      .selectFrom('companion_devices')
      .select(['secret_hash', 'activation_code_hash'])
      .where('serial_no', '=', 'HB-TEST-0001')
      .executeTakeFirstOrThrow();
    expect(row.activation_code_hash).not.toContain('ABCD1234');
    expect(Buffer.from(row.secret_hash).toString('utf8')).not.toContain(devices[0]!.deviceSecret);
  });

  it('固定话术：只有平台能改；含禁用词 400；保存是新版本、有修改记录', async () => {
    const list = await platform.get('/api/admin/companion/scripts').expect(200);
    expect(list.body.scripts.map((s: { kind: string }) => s.kind)).toContain('crisis');
    expect(list.body.scripts.map((s: { kind: string }) => s.kind)).not.toContain('notice');
    await platform
      .put('/api/admin/companion/scripts/crisis')
      .send({ text: '我们可以帮您诊断一下' })
      .expect(400)
      .expect((r) => expect(r.body.error).toBe('invalid_content'));
    await platform
      .put('/api/admin/companion/scripts/crisis')
      .send({ text: '长'.repeat(301) })
      .expect(400);
    // 危机话术删掉 120 不能保存；转交话术不能代健管师承诺
    await platform
      .put('/api/admin/companion/scripts/crisis')
      .send({ text: '请马上联系家人。' })
      .expect(400)
      .expect((r) =>
        expect(r.body.issues).toEqual([{ category: 'missing_required', term: '120', index: 0 }]),
      );
    await platform
      .put('/api/admin/companion/scripts/handoff')
      .send({ text: '已经转给健管师了，她会给您打电话。' })
      .expect(400);
    const saved = await platform
      .put('/api/admin/companion/scripts/crisis')
      .send({ text: '请马上联系家人，或拨打 120。' })
      .expect(200);
    expect(saved.body).toMatchObject({ kind: 'crisis', version: 2 });
    const history = await platform.get('/api/admin/companion/scripts/crisis/versions').expect(200);
    expect(history.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    await platform.put('/api/admin/companion/scripts/unknown').send({ text: '你好' }).expect(404);
    for (const email of [
      f.users.managerA1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
    ]) {
      const agent = await as(email);
      await agent.get('/api/admin/companion/scripts').expect(403);
      await agent.put('/api/admin/companion/scripts/crisis').send({ text: '你好' }).expect(403);
      await agent.get('/api/admin/companion/scripts/crisis/versions').expect(403);
    }
  });
});
