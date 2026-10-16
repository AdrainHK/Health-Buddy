import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { insertDraft, insertTask } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * 客户档案接口（M2 规格 3.4，验收标准 3、12、18、19）：新建和编辑客户、健康史、风险分层、档案汇总。
 * 每个接口都测跨租户拒绝：协会B、同协会其他健管师、运营商和平台管理员 → 404；
 * 机构管理员只读本机构客户的档案，不能写。
 */
describe('客户档案接口', () => {
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

  const NOT_FOUND = { error: 'not_found' };
  const as = (email: string) => loginAs(app, email);
  /** 别人的客户：协会B、同协会其他健管师、同协会别的机构 */
  const othersClients = () => [f.clients.b1, f.clients.a2, f.clients.a3];
  const adminEmails = () => [f.users.operatorAdminA.email, f.users.platform.email];

  async function addHistory(agent: Agent, clientId: string, content = '合成记录：每周快走三次') {
    const res = await agent
      .post(`/api/clients/${clientId}/health-history`)
      .send({ category: 'lifestyle', content, recordedOn: '2026-01-02' })
      .expect(201);
    return res.body.item.id as string;
  }

  describe('新建客户（Q13）', () => {
    it('健管师新建的客户只建在自己名下，请求体里的租户字段被忽略', async () => {
      const agent = await as(f.users.managerA1.email);
      const res = await agent
        .post('/api/clients')
        .send({
          displayName: '  合成新客户  ',
          gender: 'male',
          birthYear: 1980,
          operatorId: f.operatorB,
          orgId: f.orgB,
          managerId: f.users.managerB1.id,
          isSynthetic: true,
        })
        .expect(201);
      expect(res.body.client).toMatchObject({
        displayName: '合成新客户',
        gender: 'male',
        birthYear: 1980,
        managerId: f.users.managerA1.id,
        isSynthetic: false,
      });
      const row = await owner
        .selectFrom('clients')
        .select(['operator_id', 'org_id', 'manager_id'])
        .where('id', '=', res.body.client.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
      });

      const list = await agent.get('/api/clients').expect(200);
      expect(list.body.clients.map((c: { id: string }) => c.id)).toContain(res.body.client.id);
      const b1 = await as(f.users.managerB1.email);
      await b1.get(`/api/clients/${res.body.client.id}`).expect(404);
      const a2 = await as(f.users.managerA2.email);
      await a2.get(`/api/clients/${res.body.client.id}/record`).expect(404);
    });

    it('称呼必填，只收集称呼、性别和出生年份', async () => {
      const agent = await as(f.users.managerA1.email);
      for (const body of [{}, { displayName: ' ' }, { displayName: 'x', birthYear: 1800 }]) {
        await agent.post('/api/clients').send(body).expect(400);
      }
      const res = await agent
        .post('/api/clients')
        .send({ displayName: '合成客户丙', phone: '00000000000', wechat: 'x' })
        .expect(201);
      expect(Object.keys(res.body.client).sort()).toEqual(
        ['birthYear', 'displayName', 'gender', 'id', 'isSynthetic', 'managerId'].sort(),
      );
    });

    it('健管师以外的角色不能新建客户', async () => {
      for (const email of [f.users.orgAdminA.email, ...adminEmails()]) {
        const agent = await as(email);
        const res = await agent.post('/api/clients').send({ displayName: '合成客户' }).expect(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      const rows = await owner
        .selectFrom('clients')
        .select('id')
        .where('display_name', '=', '合成客户')
        .execute();
      expect(rows).toHaveLength(0);
    });
  });

  describe('编辑客户', () => {
    it('健管师可以修改自己客户的称呼、性别和出生年份', async () => {
      const agent = await as(f.users.managerA1.email);
      const res = await agent
        .patch(`/api/clients/${f.clients.a1[0]}`)
        .send({ displayName: '合成客户改名', gender: null, birthYear: 1971 })
        .expect(200);
      expect(res.body.client).toMatchObject({
        id: f.clients.a1[0],
        displayName: '合成客户改名',
        gender: null,
        birthYear: 1971,
      });
      await agent.patch(`/api/clients/${f.clients.a1[0]}`).send({}).expect(400);
    });

    it('改别人的客户 → 404，数据不变；机构管理员、运营商和平台 → 404', async () => {
      const agent = await as(f.users.managerA1.email);
      for (const id of othersClients()) {
        const res = await agent.patch(`/api/clients/${id}`).send({ displayName: 'x' }).expect(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      for (const email of [f.users.orgAdminA.email, ...adminEmails()]) {
        const admin = await as(email);
        await admin.patch(`/api/clients/${f.clients.a1[0]}`).send({ displayName: 'x' }).expect(404);
      }
      const names = await owner
        .selectFrom('clients')
        .select('display_name')
        .where('display_name', '=', 'x')
        .execute();
      expect(names).toHaveLength(0);
    });
  });

  describe('档案汇总', () => {
    it('健管师看到基本信息、分层、健康史、报告、指标趋势、日常监测和产物，各带来源和日期', async () => {
      const agent = await as(f.users.managerA1.email);
      await addHistory(agent, f.clients.a1[0]);
      await agent
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'medium', reason: '合成理由' })
        .expect(201);
      const scope = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id };
      const taskId = await insertTask(owner, scope, f.clients.a1[0]);
      const artifactId = await insertDraft(owner, scope, taskId, { clientId: f.clients.a1[0] });

      const res = await agent.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200);
      const record = res.body.record;
      expect(record.client).toMatchObject({ id: f.clients.a1[0], isSynthetic: true });
      expect(record.readOnly).toBe(false);
      expect(record.riskTier).toMatchObject({
        tier: 'medium',
        reason: '合成理由',
        setBy: f.users.managerA1.id,
        setByName: expect.any(String),
      });
      expect(record.healthHistory).toEqual([
        expect.objectContaining({ category: 'lifestyle', recordedOn: '2026-01-02' }),
      ]);
      expect(record.reports).toEqual([
        {
          id: expect.any(String),
          reportDate: '2026-01-01',
          source: 'synthetic',
          indicatorCount: 1,
        },
      ]);
      expect(record.indicators).toEqual([
        {
          code: 'fpg',
          points: [
            {
              reportId: record.reports[0].id,
              reportDate: '2026-01-01',
              source: 'synthetic',
              value: 5.5,
              unit: 'mmol/L',
            },
          ],
        },
      ]);
      expect(record.monitoring).toEqual([
        {
          metric: 'sbp',
          unit: 'mmHg',
          count: 1,
          latest: { value: 120, measuredAt: expect.any(String), source: 'synthetic' },
        },
      ]);
      expect(record.artifacts.map((a: { id: string }) => a.id)).toEqual([artifactId]);
    });

    it('机构管理员只读本机构客户的档案，看不到产物', async () => {
      const a1 = await as(f.users.managerA1.email);
      await addHistory(a1, f.clients.a1[0]);
      const scope = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id };
      const taskId = await insertTask(owner, scope, f.clients.a1[0]);
      await insertDraft(owner, scope, taskId, { clientId: f.clients.a1[0] });

      const admin = await as(f.users.orgAdminA.email);
      const res = await admin.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200);
      expect(res.body.record).toMatchObject({ readOnly: true, artifacts: [] });
      expect(res.body.record.healthHistory).toHaveLength(1);
      expect(res.body.record.reports).toHaveLength(1);
      // 别的机构、别的协会
      for (const id of [f.clients.a3, f.clients.b1]) {
        await admin.get(`/api/clients/${id}/record`).expect(404);
      }
    });

    it('别人的客户、运营商和平台管理员 → 404，和不存在的客户响应一样', async () => {
      const agent = await as(f.users.managerA1.email);
      const missing = await agent
        .get('/api/clients/00000000-0000-4000-8000-000000000000/record')
        .expect(404);
      expect(missing.body).toEqual(NOT_FOUND);
      await agent.get('/api/clients/not-a-uuid/record').expect(404);
      for (const id of othersClients()) {
        const res = await agent.get(`/api/clients/${id}/record`).expect(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      for (const email of adminEmails()) {
        const admin = await as(email);
        await admin.get(`/api/clients/${f.clients.a1[0]}/record`).expect(404);
      }
    });
  });

  describe('健康史（Q12）', () => {
    it('健管师新增、修改、删除健康史；删除后列表里没有，也不能再改', async () => {
      const agent = await as(f.users.managerA1.email);
      const id = await addHistory(agent, f.clients.a1[0]);
      const updated = await agent
        .patch(`/api/clients/${f.clients.a1[0]}/health-history/${id}`)
        .send({ category: 'medication', content: '合成记录：服用某合成药物', recordedOn: null })
        .expect(200);
      expect(updated.body.item).toMatchObject({
        id,
        category: 'medication',
        content: '合成记录：服用某合成药物',
        recordedOn: null,
      });

      const list = await agent.get(`/api/clients/${f.clients.a1[0]}/health-history`).expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([id]);

      await agent.delete(`/api/clients/${f.clients.a1[0]}/health-history/${id}`).expect(204);
      const after = await agent.get(`/api/clients/${f.clients.a1[0]}/health-history`).expect(200);
      expect(after.body.items).toEqual([]);
      await agent.delete(`/api/clients/${f.clients.a1[0]}/health-history/${id}`).expect(404);
      await agent
        .patch(`/api/clients/${f.clients.a1[0]}/health-history/${id}`)
        .send({ content: 'x' })
        .expect(404);
    });

    it('五类之外、空内容 → 400', async () => {
      const agent = await as(f.users.managerA1.email);
      for (const body of [
        { category: 'diagnosis', content: 'x' },
        { category: 'allergy', content: ' ' },
        { category: 'allergy' },
      ]) {
        await agent.post(`/api/clients/${f.clients.a1[0]}/health-history`).send(body).expect(400);
      }
    });

    it('别人的客户 → 404，不写入任何数据', async () => {
      const agent = await as(f.users.managerA1.email);
      for (const id of othersClients()) {
        await agent.get(`/api/clients/${id}/health-history`).expect(404);
        const res = await agent
          .post(`/api/clients/${id}/health-history`)
          .send({ category: 'allergy', content: '合成记录' })
          .expect(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      const rows = await owner.selectFrom('client_health_history').select('id').execute();
      expect(rows).toHaveLength(0);
    });

    it('条目属于别的客户时（即使路径里是自己的客户）→ 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      const b1 = await as(f.users.managerB1.email);
      const ownOther = await addHistory(a1, f.clients.a1[1]);
      const foreign = await addHistory(b1, f.clients.b1);
      for (const [clientId, itemId] of [
        [f.clients.a1[0], ownOther],
        [f.clients.a1[0], foreign],
        [f.clients.b1, foreign],
      ] as const) {
        await a1
          .patch(`/api/clients/${clientId}/health-history/${itemId}`)
          .send({ content: '改掉' })
          .expect(404);
        await a1.delete(`/api/clients/${clientId}/health-history/${itemId}`).expect(404);
      }
      const rows = await owner
        .selectFrom('client_health_history')
        .select(['content', 'deleted_at'])
        .execute();
      expect(rows.every((r) => r.content !== '改掉' && r.deleted_at === null)).toBe(true);
    });

    it('机构管理员只能读，不能写；运营商和平台读不到', async () => {
      const a1 = await as(f.users.managerA1.email);
      const id = await addHistory(a1, f.clients.a1[0]);
      const admin = await as(f.users.orgAdminA.email);
      const list = await admin.get(`/api/clients/${f.clients.a1[0]}/health-history`).expect(200);
      expect(list.body.items).toHaveLength(1);
      await admin
        .post(`/api/clients/${f.clients.a1[0]}/health-history`)
        .send({ category: 'allergy', content: '合成记录' })
        .expect(404);
      await admin
        .patch(`/api/clients/${f.clients.a1[0]}/health-history/${id}`)
        .send({ content: 'x' })
        .expect(404);
      await admin.delete(`/api/clients/${f.clients.a1[0]}/health-history/${id}`).expect(404);
      for (const email of adminEmails()) {
        const other = await as(email);
        await other.get(`/api/clients/${f.clients.a1[0]}/health-history`).expect(404);
      }
    });
  });

  describe('风险分层（规格 2.7）', () => {
    it('手动设定分层必须填理由；每次设定都保留历史，最新一条是当前分层', async () => {
      const agent = await as(f.users.managerA1.email);
      const url = `/api/clients/${f.clients.a1[0]}/risk-tiers`;
      await agent.post(url).send({ tier: 'high' }).expect(400);
      await agent.post(url).send({ tier: 'high', reason: '  ' }).expect(400);
      await agent.post(url).send({ tier: 'unknown', reason: 'x' }).expect(400);

      const first = await agent.post(url).send({ tier: 'high', reason: '合成理由一' }).expect(201);
      expect(first.body.tier).toMatchObject({ tier: 'high', setBy: f.users.managerA1.id });
      await agent.post(url).send({ tier: 'low', reason: '合成理由二' }).expect(201);

      const history = await agent.get(url).expect(200);
      expect(history.body.tiers.map((t: { tier: string }) => t.tier)).toEqual(['low', 'high']);
      const record = await agent.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200);
      expect(record.body.record.riskTier).toMatchObject({ tier: 'low', reason: '合成理由二' });

      // 没设定过的客户是未分层
      const other = await agent.get(`/api/clients/${f.clients.a1[1]}/record`).expect(200);
      expect(other.body.record.riskTier).toBeNull();
    });

    it('别人的客户 → 404，不写入；机构管理员只读', async () => {
      const agent = await as(f.users.managerA1.email);
      for (const id of othersClients()) {
        await agent.get(`/api/clients/${id}/risk-tiers`).expect(404);
        const res = await agent
          .post(`/api/clients/${id}/risk-tiers`)
          .send({ tier: 'high', reason: '合成理由' })
          .expect(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      const admin = await as(f.users.orgAdminA.email);
      await admin
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'high', reason: '合成理由' })
        .expect(404);
      expect(await owner.selectFrom('client_risk_tiers').select('id').execute()).toHaveLength(0);

      await agent
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'medium', reason: '合成理由' })
        .expect(201);
      const list = await admin.get(`/api/clients/${f.clients.a1[0]}/risk-tiers`).expect(200);
      expect(list.body.tiers).toHaveLength(1);
      for (const email of adminEmails()) {
        const other = await as(email);
        await other.get(`/api/clients/${f.clients.a1[0]}/risk-tiers`).expect(404);
        await other
          .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
          .send({ tier: 'high', reason: '合成理由' })
          .expect(404);
      }
    });

    it('客户转出后，档案跟着走：新健管师看得到，原健管师 404', async () => {
      const a1 = await as(f.users.managerA1.email);
      await addHistory(a1, f.clients.a1[0]);
      await a1
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'high', reason: '合成理由' })
        .expect(201);
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();

      await a1.get(`/api/clients/${f.clients.a1[0]}/record`).expect(404);
      await a1
        .post(`/api/clients/${f.clients.a1[0]}/risk-tiers`)
        .send({ tier: 'low', reason: '合成理由' })
        .expect(404);
      const a2 = await as(f.users.managerA2.email);
      const record = await a2.get(`/api/clients/${f.clients.a1[0]}/record`).expect(200);
      expect(record.body.record.healthHistory).toHaveLength(1);
      expect(record.body.record.reports).toHaveLength(1);
      // 原健管师的姓名对新健管师不可见
      expect(record.body.record.riskTier).toMatchObject({
        tier: 'high',
        setBy: f.users.managerA1.id,
        setByName: null,
      });
    });
  });

  it('日志里不出现客户称呼和健康史内容', async () => {
    const writes: string[] = [];
    const capture = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      const agent = await as(f.users.managerA1.email);
      const created = await agent
        .post('/api/clients')
        .send({ displayName: '合成日志客户' })
        .expect(201);
      const id = created.body.client.id as string;
      await agent
        .post(`/api/clients/${id}/health-history`)
        .send({ category: 'allergy', content: '合成日志内容' })
        .expect(201);
      await agent
        .post(`/api/clients/${id}/health-history`)
        .send({ category: 'allergy', content: `合成日志内容${'x'.repeat(600)}` })
        .expect(400);
      await agent
        .post(`/api/clients/${f.clients.b1}/risk-tiers`)
        .send({ tier: 'high', reason: '合成日志理由' })
        .expect(404);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const logged = writes.join('');
    for (const secret of ['合成日志客户', '合成日志内容', '合成日志理由']) {
      expect(logged).not.toContain(secret);
    }
  });
});
