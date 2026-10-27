import type { INestApplication } from '@nestjs/common';
import {
  carePlanListResponseSchema,
  carePlanResponseSchema,
  todayVisitsResponseSchema,
  visitListResponseSchema,
  visitMaterialListResponseSchema,
  visitRecordListResponseSchema,
  visitRecordResponseSchema,
  visitResponseSchema,
  type Visit,
} from '@health-buddy/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MaterialPurgeService } from '../src/care/material-purge.service.js';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

const DAY = 86_400_000;
/** 测试按 UTC 算“今天”（测试账号没有设置时区，请求也不带 tz） */
const dayOffset = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

/**
 * M5 第 3 步（3a）：方案、执行情况、随访、今日随访、素材、记录和补充说明的接口（规格 6.4）。
 * 每个接口都有“跨租户访问被拒绝”的测试：协会 B 健管师、同机构其他健管师、其他机构健管师、
 * 机构管理员、运营商、平台都是 404，且不写任何行。方案和记录以所有者身份写入（相当于确认函数，3b 接入）。
 * 全部是合成数据。
 */
describe('方案和随访接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  const as = (u: Account, a: INestApplication = app) => loginAs(a, u.email);
  const others = () => [
    f.users.managerA2,
    f.users.managerA3,
    f.users.managerB1,
    f.users.orgAdminA,
    f.users.operatorAdminA,
    f.users.platform,
  ];

  let goalId: string;

  async function addPlan(
    clientId: string,
    status: 'active' | 'superseded' = 'active',
    approvedAgoDays = 0,
  ): Promise<string> {
    const row = await owner
      .insertInto('care_plans')
      .values({
        client_id: clientId,
        lineage_id: randomUUID(),
        sections: ['exercise'],
        snapshot: JSON.stringify({
          structured: {
            sections: [
              {
                section: 'exercise',
                professional: '合成专业版',
                clientFacing: '合成通俗版',
                goals: [{ templateId: goalId, params: { steps: 6000 } }],
              },
            ],
            recipes: [],
            exercises: [],
          },
          content: { professional: '合成专业版', clientFacing: '合成通俗版' },
          libraryVersions: [{ type: 'goal_template', id: goalId, version: 1 }],
        }),
        cycle_weeks: 8,
        start_date: dayOffset(-approvedAgoDays),
        review_date: dayOffset(56 - approvedAgoDays),
        status,
        approved_by: (await managerOf(clientId)) as string,
        ...(status === 'superseded' ? { ended_at: new Date() } : {}),
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  }

  async function managerOf(clientId: string) {
    const c = await owner
      .selectFrom('clients')
      .select('manager_id')
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    return c.manager_id as string;
  }

  async function addRecord(clientId: string, visitDate = dayOffset(-1)): Promise<string> {
    const row = await owner
      .insertInto('visit_records')
      .values({
        client_id: clientId,
        visit_date: visitDate,
        method: 'phone',
        snapshot: JSON.stringify({
          visitDate,
          method: 'phone',
          summary: '合成随访摘要：客户说最近晚饭后散步，每周约四次，睡眠比上月规律。'.repeat(2),
          feedback: [],
          planProgress: [],
          agreements: [],
          attentionPoints: [],
          historySuggestions: [],
          openQuestions: [],
        }),
        approved_by: await managerOf(clientId),
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  }

  async function addVisit(clientId: string, due: string, over: Record<string, unknown> = {}) {
    const row = await owner
      .insertInto('visits')
      .values({
        client_id: clientId,
        due_date: due,
        method: 'phone',
        purpose: 'routine',
        origin: 'schedule',
        created_by: await managerOf(clientId),
        ...over,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  }

  const visitRows = () => owner.selectFrom('visits').selectAll().orderBy('id').execute();

  beforeAll(async () => {
    f = await seedFixtures(owner);
    goalId = (
      await owner
        .insertInto('plan_goal_templates')
        .values({
          code: 'test-daily-steps',
          section: 'exercise',
          text: '每天步行 {steps} 步',
          params: JSON.stringify([
            { name: 'steps', type: 'int', min: 4000, max: 10000, default: 6000, unit: '步' },
          ]),
          metric: 'steps',
          metric_param: 'steps',
          status: 'published',
          reviewed_by_label: '合成审定人',
          reviewed_on: '2026-10-01',
          source_note: '合成',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  describe('方案', () => {
    let current: string;
    let old: string;

    beforeAll(async () => {
      old = await addPlan(f.clients.a1[0], 'superseded', 60);
      current = await addPlan(f.clients.a1[0]);
    });

    it('当前方案和历史方案；快照全文', async () => {
      const m = await as(f.users.managerA1);
      const list = carePlanListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a1[0]}/care-plans`).expect(200)).body,
      );
      expect(list.current?.id).toBe(current);
      expect(list.current).toMatchObject({ cycleWeeks: 8, startDate: dayOffset(0) });
      expect(list.history.map((p) => p.id)).toEqual([old]);
      const full = carePlanResponseSchema.parse(
        (await m.get(`/api/care-plans/${current}`).expect(200)).body,
      );
      expect(full.plan.snapshot.content.clientFacing).toBe('合成通俗版');
      // 没有方案的客户
      const empty = carePlanListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a1[1]}/care-plans`).expect(200)).body,
      );
      expect(empty).toEqual({ current: null, history: [] });
    });

    it('跨租户：别的健管师、机构管理员、运营商、平台都是 404；无登录 401', async () => {
      for (const u of others()) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/care-plans`).expect(404);
        await agent.get(`/api/care-plans/${current}`).expect(404);
        await agent.get(`/api/clients/${f.clients.a1[0]}/care-plans/current/adherence`).expect(404);
        await agent.post(`/api/care-plans/${current}/end`).send({ reason: 'other' }).expect(404);
      }
      await request(app.getHttpServer()).get(`/api/care-plans/${current}`).expect(401);
      const row = await owner
        .selectFrom('care_plans')
        .select('status')
        .where('id', '=', current)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('active');
    });

    it('执行情况：步数目标的近 7、14 天；不生成跟进项', async () => {
      const followUpsBefore = await owner.selectFrom('follow_up_items').select('id').execute();
      await owner
        .insertInto('monitoring_readings')
        .values(
          [0, 1, 2, 3, 10].map((ago, i) => ({
            client_id: f.clients.a1[0],
            metric: 'steps',
            value: [7000, 5000, 6500, 8000, 3000][i]!,
            unit: 'steps',
            measured_at: new Date(Date.now() - ago * DAY),
            source: 'synthetic' as const,
          })) as never,
        )
        .execute();
      const m = await as(f.users.managerA1);
      const res = await m
        .get(`/api/clients/${f.clients.a1[0]}/care-plans/current/adherence`)
        .expect(200);
      const goal = res.body.adherence.goals[0];
      expect(goal).toMatchObject({
        templateId: goalId,
        metric: 'steps',
        target: 6000,
        hasData: true,
      });
      expect(goal.windows).toEqual([
        { days: 7, daysWithData: 4, average: 6625, daysMet: 3 },
        { days: 14, daysWithData: 5, average: 5900, daysMet: 3 },
      ]);
      expect(await owner.selectFrom('follow_up_items').select('id').execute()).toEqual(
        followUpsBefore,
      );
      // 没有生效方案
      const none = await m
        .get(`/api/clients/${f.clients.a1[1]}/care-plans/current/adherence`)
        .expect(200);
      expect(none.body).toEqual({ adherence: null });
    });

    it('结束方案：原因必填；已结束的再结束 409', async () => {
      const m = await as(f.users.managerA1);
      await m.post(`/api/care-plans/${current}/end`).send({}).expect(400);
      const ended = await m
        .post(`/api/care-plans/${current}/end`)
        .send({ reason: 'client_paused' })
        .expect(200);
      expect(ended.body.plan).toMatchObject({ status: 'ended', endReason: 'client_paused' });
      await m.post(`/api/care-plans/${current}/end`).send({ reason: 'other' }).expect(409);
      await m.post(`/api/care-plans/${old}/end`).send({ reason: 'other' }).expect(409);
    });
  });

  describe('随访', () => {
    it('加一次随访：日期在今天到 6 个月后；从跟进项发起记为跟进项回访；跟进项必须是这位客户的', async () => {
      const m = await as(f.users.managerA1);
      const created = visitResponseSchema.parse(
        (
          await m
            .post(`/api/clients/${f.clients.a1[0]}/visits`)
            .send({ dueDate: dayOffset(3), method: 'wechat', focus: '了解晚饭后散步的情况' })
            .expect(201)
        ).body,
      );
      expect(created.visit).toMatchObject({
        status: 'planned',
        origin: 'manual',
        purpose: 'adhoc',
        dueDate: dayOffset(3),
      });
      await m
        .post(`/api/clients/${f.clients.a1[0]}/visits`)
        .send({ dueDate: dayOffset(-1), method: 'phone' })
        .expect(400);
      await m
        .post(`/api/clients/${f.clients.a1[0]}/visits`)
        .send({ dueDate: dayOffset(200), method: 'phone' })
        .expect(400);

      const item = await owner
        .insertInto('follow_up_items')
        .values({
          client_id: f.clients.a1[0],
          kind: 'status_worsened',
          severity: 3,
          domain: 'metabolic',
          dedupe_key: 'care-test',
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      const fromItem = visitResponseSchema.parse(
        (
          await m
            .post(`/api/clients/${f.clients.a1[0]}/visits`)
            .send({ dueDate: dayOffset(1), method: 'phone', followUpItemId: item.id })
            .expect(201)
        ).body,
      );
      expect(fromItem.visit).toMatchObject({ purpose: 'follow_up', followUpItemId: item.id });
      // 跟进项属于别的客户 → 404，不写
      const before = await visitRows();
      await m
        .post(`/api/clients/${f.clients.a1[1]}/visits`)
        .send({ dueDate: dayOffset(1), method: 'phone', followUpItemId: item.id })
        .expect(404);
      expect(await visitRows()).toEqual(before);
    });

    it('跨租户：给别人的客户加随访、处理别人的随访、看别人的日程都是 404，不改任何行', async () => {
      const visit = await addVisit(f.clients.a1[0], dayOffset(2));
      const before = await visitRows();
      for (const u of others()) {
        const agent = await as(u);
        await agent
          .post(`/api/clients/${f.clients.a1[0]}/visits`)
          .send({ dueDate: dayOffset(2), method: 'phone' })
          .expect(404);
        await agent
          .patch(`/api/visits/${visit}`)
          .send({ action: 'cancel', cancelReason: 'other' })
          .expect(404);
        if ([f.users.managerA2, f.users.managerA3, f.users.managerB1].includes(u)) {
          await agent.get(`/api/visits?clientId=${f.clients.a1[0]}`).expect(404);
          const today = todayVisitsResponseSchema.parse(
            (await agent.get('/api/visits/today').expect(200)).body,
          );
          expect(today.items.map((i) => i.clientId)).not.toContain(f.clients.a1[0]);
        } else {
          await agent.get('/api/visits/today').expect(404);
          await agent.get('/api/visits').expect(404);
        }
      }
      expect(await visitRows()).toEqual(before);
    });

    it('今日随访：今天到期和逾期的；逾期多的在前，方案复评和跟进项回访在前', async () => {
      const m = await as(f.users.managerA1);
      const a = await addVisit(f.clients.a1[1], dayOffset(0), { purpose: 'routine' });
      const b = await addVisit(f.clients.a1[1], dayOffset(-1), { purpose: 'routine' });
      const c = await addVisit(f.clients.a1[1], dayOffset(0), { purpose: 'follow_up' });
      const later = await addVisit(f.clients.a1[1], dayOffset(5));
      const done = await addVisit(f.clients.a1[1], dayOffset(-2), {
        status: 'done',
        note: '合成备注',
        done_at: new Date(),
      });
      const today = todayVisitsResponseSchema.parse(
        (await m.get('/api/visits/today').expect(200)).body,
      );
      const ids = today.items.map((i) => i.id);
      expect(ids).not.toContain(later);
      expect(ids).not.toContain(done);
      const mine = ids.filter((id) => [a, b, c].includes(id));
      expect(mine).toEqual([b, c, a]);
      const overdue = today.items.find((i) => i.id === b)!;
      expect(overdue).toMatchObject({ overdueDays: 1, clientName: expect.any(String) });
      expect(today.date).toBe(dayOffset(0));
    });

    it('处理：未联系上默认顺延 2 天；改期；完成要关联记录或备注；取消要原因；已处理的 409', async () => {
      const m = await as(f.users.managerA1);
      const v = await addVisit(f.clients.a1[1], dayOffset(0));
      const missed = visitResponseSchema.parse(
        (await m.patch(`/api/visits/${v}`).send({ action: 'missed' }).expect(200)).body,
      );
      expect(missed.visit).toMatchObject({
        status: 'missed',
        dueDate: dayOffset(2),
        rescheduledFrom: dayOffset(0),
      });
      const moved = visitResponseSchema.parse(
        (
          await m
            .patch(`/api/visits/${v}`)
            .send({ action: 'reschedule', newDate: dayOffset(4) })
            .expect(200)
        ).body,
      );
      expect(moved.visit).toMatchObject({ status: 'planned', dueDate: dayOffset(4) });
      await m.patch(`/api/visits/${v}`).send({ action: 'done' }).expect(400);
      // 别的客户的记录 → 404
      const otherRecord = await addRecord(f.clients.a1[0]);
      await m.patch(`/api/visits/${v}`).send({ action: 'done', recordId: otherRecord }).expect(404);
      const ownRecord = await addRecord(f.clients.a1[1]);
      const done = visitResponseSchema.parse(
        (
          await m
            .patch(`/api/visits/${v}`)
            .send({ action: 'done', recordId: ownRecord })
            .expect(200)
        ).body,
      );
      expect(done.visit).toMatchObject({ status: 'done', recordId: ownRecord });
      expect(done.visit.doneAt).not.toBeNull();
      await m
        .patch(`/api/visits/${v}`)
        .send({ action: 'cancel', cancelReason: 'duplicate' })
        .expect(409);

      const w = await addVisit(f.clients.a1[1], dayOffset(1));
      await m.patch(`/api/visits/${w}`).send({ action: 'cancel' }).expect(400);
      const cancelled = visitResponseSchema.parse(
        (
          await m
            .patch(`/api/visits/${w}`)
            .send({ action: 'cancel', cancelReason: 'contacted_elsewhere' })
            .expect(200)
        ).body,
      );
      expect(cancelled.visit).toMatchObject({
        status: 'cancelled',
        cancelReason: 'contacted_elsewhere',
      });

      // 处理记录进入 visit_events（只记动作，不记备注）
      const events = await owner
        .selectFrom('visit_events')
        .select('action')
        .where('visit_id', '=', v)
        .orderBy('id')
        .execute();
      expect(events.map((e) => e.action)).toEqual(['created', 'missed', 'rescheduled', 'done']);
    });

    it('等方案生效的复评只能取消', async () => {
      const m = await as(f.users.managerA1);
      const pending = await addVisit(f.clients.a1[1], dayOffset(30), {
        purpose: 'plan_review',
        status: 'pending_plan',
      });
      await m
        .patch(`/api/visits/${pending}`)
        .send({ action: 'reschedule', newDate: dayOffset(10) })
        .expect(409);
      await m
        .patch(`/api/visits/${pending}`)
        .send({ action: 'cancel', cancelReason: 'other' })
        .expect(200);
    });

    it('随访日程按客户、状态和日期筛选', async () => {
      const m = await as(f.users.managerA1);
      const list = visitListResponseSchema.parse(
        (
          await m
            .get(`/api/visits?clientId=${f.clients.a1[1]}&status=planned&from=${dayOffset(0)}`)
            .expect(200)
        ).body,
      );
      expect(list.visits.length).toBeGreaterThan(0);
      expect(
        list.visits.every(
          (v: Visit) =>
            v.clientId === f.clients.a1[1] && v.status === 'planned' && v.dueDate >= dayOffset(0),
        ),
      ).toBe(true);
      await m.get('/api/visits?from=2026-13-01').expect(400);
    });
  });

  describe('随访素材', () => {
    const text = '合成聊天记录：客户说最近每天晚饭后散步二十分钟。';

    it('第一次上传必须勾选“已告知客户”；原文加密存储，列表不含原文', async () => {
      const m = await as(f.users.managerA1);
      const first = await m
        .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
        .send({ text })
        .expect(400);
      expect(first.body.reasons).toEqual(['consent_required']);
      expect(await owner.selectFrom('visit_materials').select('id').execute()).toEqual([]);

      const created = await m
        .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
        .send({ text, consentConfirmed: true })
        .expect(201);
      expect(created.body.material).toMatchObject({
        clientId: f.clients.a1[0],
        kind: 'paste',
        charCount: Array.from(text).length,
        purged: false,
      });
      expect(JSON.stringify(created.body)).not.toContain('散步');
      // 以后不再询问
      await m
        .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
        .send({ text: '合成通话笔记', source: 'txt' })
        .expect(201);

      const stored = await owner
        .selectFrom('visit_materials')
        .select('text_encrypted')
        .where('id', '=', created.body.material.id)
        .executeTakeFirstOrThrow();
      expect(Buffer.from(stored.text_encrypted as Buffer).includes(Buffer.from('散步'))).toBe(
        false,
      );

      const list = visitMaterialListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a1[0]}/visit-materials`).expect(200)).body,
      );
      expect(list.consentRecorded).toBe(true);
      expect(list.materials.map((x) => x.kind).sort()).toEqual(['paste', 'txt']);
      expect(JSON.stringify(list)).not.toContain('散步');
    });

    it('超过 20000 字 → 413；关联别的客户的随访 → 404', async () => {
      const m = await as(f.users.managerA1);
      await m
        .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
        .send({ text: '字'.repeat(20001) })
        .expect(413);
      const otherVisit = await addVisit(f.clients.a1[1], dayOffset(3));
      await m
        .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
        .send({ text, visitId: otherVisit })
        .expect(404);
    });

    it('跨租户：同机构其他健管师也看不到、删不掉；给别人的客户上传 → 404 不写', async () => {
      const m = await as(f.users.managerA1);
      const list = visitMaterialListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a1[0]}/visit-materials`).expect(200)).body,
      );
      const id = list.materials[0]!.id;
      const before = await owner.selectFrom('visit_materials').select('id').execute();
      for (const u of others()) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/visit-materials`).expect(404);
        await agent.delete(`/api/visit-materials/${id}`).expect(404);
        await agent
          .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
          .send({ text, consentConfirmed: true })
          .expect(404);
      }
      expect(await owner.selectFrom('visit_materials').select('id').execute()).toEqual(before);
      // 本人可以删除
      await m.delete(`/api/visit-materials/${id}`).expect(204);
      await m.delete(`/api/visit-materials/${id}`).expect(404);
    });

    it('没有配置加密密钥时上传 → 503', async () => {
      const bare = await createTestApp({ visitMaterialKey: undefined });
      try {
        const m = await as(f.users.managerA1, bare);
        const res = await m
          .post(`/api/clients/${f.clients.a1[0]}/visit-materials`)
          .send({ text })
          .expect(503);
        expect(res.body.error).toBe('not_configured');
      } finally {
        await bare.close();
      }
    });

    it('每位健管师每天最多 100 份', async () => {
      const m = await as(f.users.managerA2);
      await m
        .post(`/api/clients/${f.clients.a2}/visit-materials`)
        .send({ text, consentConfirmed: true })
        .expect(201);
      await owner
        .insertInto('visit_materials')
        .values(
          Array.from({ length: 99 }, () => ({
            client_id: f.clients.a2,
            kind: 'paste',
            text_encrypted: Buffer.from([0]),
            char_count: 1,
            uploaded_by: f.users.managerA2.id,
            purge_after: new Date(Date.now() + 30 * DAY),
          })) as never,
        )
        .execute();
      const res = await m
        .post(`/api/clients/${f.clients.a2}/visit-materials`)
        .send({ text })
        .expect(429);
      expect(res.body.reasons).toEqual(['daily_limit']);
    });

    it('到期的原文由清理任务删除，素材行保留', async () => {
      const m = await as(f.users.managerA1);
      const created = await m
        .post(`/api/clients/${f.clients.a1[1]}/visit-materials`)
        .send({ text, consentConfirmed: true })
        .expect(201);
      const id = created.body.material.id as string;
      // 用可控的时间：把到期时间改到过去（相当于 30 天后）
      await owner
        .updateTable('visit_materials')
        .set({ purge_after: new Date(Date.now() - 1000) } as never)
        .where('id', '=', id)
        .execute();
      const purged = await app.get(MaterialPurgeService).run();
      expect(purged).toBeGreaterThanOrEqual(1);
      const row = await owner
        .selectFrom('visit_materials')
        .select(['text_encrypted', 'purged_at', 'char_count'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.text_encrypted).toBeNull();
      expect(row.purged_at).not.toBeNull();
      expect(row.char_count).toBe(Array.from(text).length);
      const list = visitMaterialListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a1[1]}/visit-materials`).expect(200)).body,
      );
      expect(list.materials.find((x) => x.id === id)?.purged).toBe(true);
    });
  });

  describe('随访记录', () => {
    it('列表、全文和补充说明；记录本身不能改', async () => {
      const recordId = await addRecord(f.clients.a3, dayOffset(-3));
      const m = await as(f.users.managerA3);
      const list = visitRecordListResponseSchema.parse(
        (await m.get(`/api/clients/${f.clients.a3}/visit-records`).expect(200)).body,
      );
      expect(list.records[0]).toMatchObject({ id: recordId, visitDate: dayOffset(-3) });
      expect(Array.from(list.records[0]!.excerpt)).toHaveLength(50);
      await m.post(`/api/visit-records/${recordId}/addenda`).send({ text: '' }).expect(400);
      const added = visitRecordResponseSchema.parse(
        (
          await m
            .post(`/api/visit-records/${recordId}/addenda`)
            .send({ text: '合成补充：随访方式应为微信' })
            .expect(201)
        ).body,
      );
      expect(added.record.addenda.map((a) => a.text)).toEqual(['合成补充：随访方式应为微信']);
      const full = visitRecordResponseSchema.parse(
        (await m.get(`/api/visit-records/${recordId}`).expect(200)).body,
      );
      expect(full.record.snapshot.method).toBe('phone');
    });

    it('跨租户：别人的记录看不到、不能补充说明，不写任何行', async () => {
      const recordId = await addRecord(f.clients.a3);
      const before = await owner.selectFrom('visit_record_addenda').select('id').execute();
      for (const u of [
        f.users.managerA1,
        f.users.managerA2,
        f.users.managerB1,
        f.users.orgAdminA2,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a3}/visit-records`).expect(404);
        await agent.get(`/api/visit-records/${recordId}`).expect(404);
        await agent
          .post(`/api/visit-records/${recordId}/addenda`)
          .send({ text: '合成越权补充' })
          .expect(404);
      }
      expect(await owner.selectFrom('visit_record_addenda').select('id').execute()).toEqual(before);
    });
  });
});
