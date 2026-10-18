import type { INestApplication } from '@nestjs/common';
import {
  followUpListResponseSchema,
  monitoringReadingListResponseSchema,
  worstTwinLevel,
  twinForecastDetailResponseSchema,
  twinLevelsResponseSchema,
  twinOrgAdminResponseSchema,
  twinResponseSchema,
  twinRulesResponseSchema,
  twinStatsResponseSchema,
  twinTimelineResponseSchema,
  type FollowUpItem,
  type TwinResponse,
} from '@health-buddy/shared';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TWIN_QUEUE, type InProcessTwinQueue } from '../src/twin/twin-queue.js';
import { localDate, zonedDayStart, addDays } from '../src/twin/time-zone.js';
import { ownerDb, seedFixtures, type Account, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * M4 孪生接口（规格 7.4）：每个接口都有“跨租户访问被拒绝”的测试，按 7.4 最后一列逐条写。
 * 全部是合成数据，以所有者身份写入测试用的报告和监测读数。
 */
describe('孪生接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let queue: InProcessTwinQueue;

  const as = (u: Account) => loginAs(app, u.email);

  async function addReadings(
    clientId: string,
    metric: string,
    unit: string,
    points: [number, number][],
  ): Promise<string[]> {
    const rows = await owner
      .insertInto('monitoring_readings')
      .values(
        points.map(([ago, value]) => ({
          client_id: clientId,
          metric,
          value,
          unit,
          measured_at: daysAgo(ago),
          source: 'synthetic',
        })),
      )
      .returning('id')
      .execute();
    return rows.map((r) => String(r.id));
  }

  async function addReport(
    clientId: string,
    ago: number,
    indicators: { code: string; value: number; unit: string; low?: number; high?: number }[],
  ): Promise<{ reportId: string; indicatorIds: string[] }> {
    const report = await owner
      .insertInto('health_reports')
      .values({
        client_id: clientId,
        report_date: isoDate(daysAgo(ago)),
        title: '合成报告',
        source: 'synthetic',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const rows = await owner
      .insertInto('report_indicators')
      .values(
        indicators.map((i) => ({
          report_id: report.id,
          client_id: clientId,
          code: i.code,
          value: i.value,
          unit: i.unit,
          ...(i.low !== undefined || i.high !== undefined
            ? {
                ref_low: i.low ?? null,
                ref_high: i.high ?? null,
                ref_text: `${i.low ?? ''}-${i.high ?? ''}`,
                abnormal:
                  i.high !== undefined && i.value > i.high
                    ? 'high'
                    : i.low !== undefined && i.value < i.low
                      ? 'low'
                      : 'normal',
              }
            : {}),
        })),
      )
      .returning('id')
      .execute();
    return { reportId: report.id as string, indicatorIds: rows.map((r) => r.id as string) };
  }

  const twinRows = (table: string, clientId: string) =>
    owner.selectFrom(table).selectAll().where('client_id', '=', clientId).execute();

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp();
    queue = app.get(TWIN_QUEUE);
  });

  afterAll(async () => {
    await queue.idle();
    await app.close();
    await owner.destroy();
  });

  // ---------- GET /api/clients/:id/twin ----------

  describe('GET /api/clients/:id/twin', () => {
    it('健管师打开自己的客户：没算过的先补算（显示正在更新），算完后四个方面都有状态', async () => {
      const a1 = await as(f.users.managerA1);
      const first = await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200);
      const view = twinResponseSchema.parse(first.body);
      expect(view.hasData).toBe(true);
      expect(view.computing).toBe(true);
      expect(queue.jobs.at(-1)?.data).toEqual({
        type: 'client',
        clientId: f.clients.a1[0],
        trigger: 'backfill',
      });
      await queue.idle();

      const second = twinResponseSchema.parse(
        (await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200)).body,
      );
      expect(second.computing).toBe(false);
      expect(second.domains.map((d) => d.domain)).toEqual([
        'metabolic',
        'cardiovascular',
        'sleep',
        'weight',
      ]);
      expect(second.domains.find((d) => d.domain === 'cardiovascular')!.computed).toMatchObject({
        origin: 'computed',
        trigger: 'backfill',
      });
      // 补算按批量处理，不生成跟进项
      expect(await twinRows('follow_up_items', f.clients.a1[0])).toEqual([]);
      // 已经算过的客户再打开不再排任务
      const jobs = queue.jobs.length;
      await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200);
      expect(queue.jobs.length).toBe(jobs);
    });

    it('没有任何数据的客户：空状态，四个方面都是灰色，不排任务', async () => {
      const a1 = await as(f.users.managerA1);
      const jobs = queue.jobs.length;
      const view = twinResponseSchema.parse(
        (await a1.get(`/api/clients/${f.clients.a1[1]}/twin`).expect(200)).body,
      );
      expect(view).toMatchObject({ hasData: false, computing: false, forecasts: [] });
      expect(view.domains.every((d) => d.level === 'unknown')).toBe(true);
      expect(queue.jobs.length).toBe(jobs);
    });

    it('跨租户：协会 B 健管师、同协会其他健管师、运营商、平台、别的机构的机构管理员 → 404', async () => {
      for (const u of [
        f.users.managerB1,
        f.users.managerA2,
        f.users.operatorAdminA,
        f.users.platform,
        f.users.orgAdminA2,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(404);
      }
      await request(app.getHttpServer()).get(`/api/clients/${f.clients.a1[0]}/twin`).expect(401);
    });

    it('本机构的机构管理员能读，响应用单独的 schema：没有预测、跟进项和计算中标记（Q20）', async () => {
      const org = await as(f.users.orgAdminA);
      const res = await org.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['client', 'domains', 'hasData', 'riskTier']);
      const view = twinOrgAdminResponseSchema.strict().parse(res.body);
      expect(view.domains.find((d) => d.domain === 'cardiovascular')!.computed).not.toBeNull();
    });
  });

  // ---------- 手动调整 POST /status、DELETE /status/:domain ----------

  describe('手动调整状态', () => {
    it('理由必填（不少于 5 个字），不能调成“数据不足”', async () => {
      const a1 = await as(f.users.managerA1);
      for (const body of [
        { domain: 'cardiovascular', level: 'green' },
        { domain: 'cardiovascular', level: 'green', reason: '正常' },
        { domain: 'cardiovascular', level: 'unknown', reason: '客户已复查，结果正常' },
      ]) {
        await a1.post(`/api/clients/${f.clients.a1[0]}/twin/status`).send(body).expect(400);
      }
    });

    it('别人的客户 → 404 且不写任何行；机构管理员 → 404', async () => {
      const before = await twinRows('twin_status_history', f.clients.a1[0]);
      for (const u of [f.users.managerB1, f.users.managerA2, f.users.orgAdminA]) {
        const agent = await as(u);
        await agent
          .post(`/api/clients/${f.clients.a1[0]}/twin/status`)
          .send({ domain: 'cardiovascular', level: 'red', reason: '越权测试的理由' })
          .expect(404);
        await agent
          .delete(`/api/clients/${f.clients.a1[0]}/twin/status/cardiovascular`)
          .expect(404);
      }
      expect(await twinRows('twin_status_history', f.clients.a1[0])).toEqual(before);
    });

    it('调整后同时显示系统计算和手动调整；请求体里的租户字段被忽略；新数据进来后失效', async () => {
      const a1 = await as(f.users.managerA1);
      const res = await a1
        .post(`/api/clients/${f.clients.a1[0]}/twin/status`)
        .send({
          domain: 'cardiovascular',
          level: 'yellow',
          reason: '客户自述近期睡眠差，先留意',
          operator_id: f.operatorB,
          manager_id: f.users.managerB1.id,
        })
        .expect(200);
      expect(res.body.domain).toMatchObject({
        domain: 'cardiovascular',
        level: 'yellow',
        manual: { origin: 'manual', level: 'yellow', manualExpires: 'next_data' },
        computed: { origin: 'computed', level: 'green' },
        manualExpiredByNewData: false,
      });
      const row = await owner
        .selectFrom('twin_status_history')
        .select(['operator_id', 'manager_id', 'set_by'])
        .where('client_id', '=', f.clients.a1[0])
        .where('origin', '=', 'manual')
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        operator_id: f.operatorA,
        manager_id: f.users.managerA1.id,
        set_by: f.users.managerA1.id,
      });

      // 这个方面有新数据进来：手动调整失效，恢复系统计算并提示
      await addReadings(f.clients.a1[0], 'heart_rate', 'bpm', [[0.1, 72]]);
      const view = twinResponseSchema.parse(
        (await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200)).body,
      );
      const cardio = view.domains.find((d) => d.domain === 'cardiovascular')!;
      expect(cardio).toMatchObject({ manual: null, manualExpiredByNewData: true, level: 'green' });
      // 没有生效的手动调整时取消 → 409
      await a1.delete(`/api/clients/${f.clients.a1[0]}/twin/status/cardiovascular`).expect(409);
    });

    it('取消调整：恢复系统计算，历史里记一行 manual_cleared', async () => {
      const a1 = await as(f.users.managerA1);
      await a1
        .post(`/api/clients/${f.clients.a1[0]}/twin/status`)
        .send({ domain: 'weight', level: 'yellow', reason: '体重近期波动，需要留意' })
        .expect(200);
      const res = await a1.delete(`/api/clients/${f.clients.a1[0]}/twin/status/weight`).expect(200);
      expect(res.body.domain).toMatchObject({ manual: null, manualExpiredByNewData: false });
      await a1.delete(`/api/clients/${f.clients.a1[0]}/twin/status/liver`).expect(404);
      const origins = (
        await owner
          .selectFrom('twin_status_history')
          .select('origin')
          .where('client_id', '=', f.clients.a1[0])
          .where('domain', '=', 'weight')
          .orderBy('created_at')
          .execute()
      ).map((r) => r.origin);
      expect(origins.slice(-2)).toEqual(['manual', 'manual_cleared']);
    });
  });

  // ---------- GET /status-history ----------

  describe('GET /api/clients/:id/twin/status-history', () => {
    it('自己的客户和本机构管理员能读；domain 可筛选；别人的客户 → 404', async () => {
      const a1 = await as(f.users.managerA1);
      const all = await a1.get(`/api/clients/${f.clients.a1[0]}/twin/status-history`).expect(200);
      expect(all.body.records.length).toBeGreaterThanOrEqual(4);
      const weight = await a1
        .get(`/api/clients/${f.clients.a1[0]}/twin/status-history?domain=weight`)
        .expect(200);
      expect(new Set(weight.body.records.map((r: { domain: string }) => r.domain))).toEqual(
        new Set(['weight']),
      );
      await a1.get(`/api/clients/${f.clients.a1[0]}/twin/status-history?domain=x`).expect(400);
      const org = await as(f.users.orgAdminA);
      await org.get(`/api/clients/${f.clients.a1[0]}/twin/status-history`).expect(200);
      for (const u of [
        f.users.managerB1,
        f.users.managerA2,
        f.users.orgAdminA2,
        f.users.operatorAdminA,
        f.users.operatorAdminB,
        f.users.platform,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/twin/status-history`).expect(404);
      }
    });
  });

  // ---------- 预测大图 ----------

  describe('GET /api/clients/:id/twin/forecasts/:metric', () => {
    it('健管师看到历次数值和预测；不预测的指标 → 404；别人的客户、机构管理员、运营商、平台 → 404', async () => {
      // 26 周体重读数，每天一条
      await addReadings(
        f.clients.a1[0],
        'weight',
        'kg',
        Array.from({ length: 182 }, (_, i) => [i + 0.5, 70 + (i % 3) * 0.3] as [number, number]),
      );
      const a1 = await as(f.users.managerA1);
      await a1
        .post(`/api/clients/${f.clients.a1[0]}/monitoring-readings`)
        .send({ metric: 'weight', value: 70.2, measuredAt: new Date().toISOString() })
        .expect(201);
      await queue.idle();
      const res = await a1.get(`/api/clients/${f.clients.a1[0]}/twin/forecasts/weight`).expect(200);
      const detail = twinForecastDetailResponseSchema.parse(res.body);
      expect(detail.unit).toBe('kg');
      expect(detail.actual.some((p) => p.manual)).toBe(true);
      expect(detail.forecasts.find((x) => x.source === 'monitoring')).toMatchObject({
        status: 'ok',
        methodVersion: 'ols-linear-v1',
      });
      // 拟合参数不给前端
      expect(JSON.stringify(res.body)).not.toContain('slopePerDay');

      await a1.get(`/api/clients/${f.clients.a1[0]}/twin/forecasts/alt`).expect(404);
      for (const u of [
        f.users.managerB1,
        f.users.managerA2,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/twin/forecasts/weight`).expect(404);
      }
    });
  });

  // ---------- 手动录入监测 ----------

  describe('POST /api/clients/:id/monitoring-readings、DELETE /api/monitoring-readings/:id', () => {
    it('录入自己的客户：单位跟目录、标手动、排一个只带客户 id 的计算任务', async () => {
      const a1 = await as(f.users.managerA1);
      const res = await a1
        .post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`)
        .send({ metric: 'sbp', value: 132, measuredAt: new Date().toISOString() })
        .expect(201);
      expect(res.body.reading).toMatchObject({
        metric: 'sbp',
        unit: 'mmHg',
        value: 132,
        source: 'manual',
        deletable: true,
      });
      expect(queue.jobs.at(-1)?.data).toEqual({
        type: 'client',
        clientId: f.clients.a1[1],
        trigger: 'monitoring',
      });
      await queue.idle();
    });

    it('值超出合理范围、不在目录、时间在将来 → 400', async () => {
      const a1 = await as(f.users.managerA1);
      for (const body of [
        { metric: 'sbp', value: 900, measuredAt: new Date().toISOString() },
        { metric: 'alt', value: 30, measuredAt: new Date().toISOString() },
        { metric: 'sbp', value: 120, measuredAt: new Date(Date.now() + 3600_000).toISOString() },
      ]) {
        await a1.post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`).send(body).expect(400);
      }
    });

    it('别人的客户 → 404 且不写入；机构管理员 → 404', async () => {
      const before = await twinRows('monitoring_readings', f.clients.a1[1]);
      for (const u of [f.users.managerB1, f.users.managerA2, f.users.orgAdminA]) {
        const agent = await as(u);
        await agent
          .post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`)
          .send({ metric: 'sbp', value: 120, measuredAt: new Date().toISOString() })
          .expect(404);
      }
      expect(await twinRows('monitoring_readings', f.clients.a1[1])).toEqual(before);
    });

    it('删除：自己手动录入的 204；合成数据 → 409；别人的读数 → 404', async () => {
      const a1 = await as(f.users.managerA1);
      const created = await a1
        .post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`)
        .send({ metric: 'dbp', value: 80, measuredAt: new Date().toISOString() })
        .expect(201);
      const id = created.body.reading.id as string;
      for (const u of [f.users.managerB1, f.users.managerA2, f.users.orgAdminA]) {
        const agent = await as(u);
        await agent.delete(`/api/monitoring-readings/${id}`).expect(404);
      }
      await a1.delete(`/api/monitoring-readings/${id}`).expect(204);
      await a1.delete(`/api/monitoring-readings/${id}`).expect(404);
      const [synthetic] = await addReadings(f.clients.a1[1], 'sbp', 'mmHg', [[3, 121]]);
      await a1.delete(`/api/monitoring-readings/${synthetic}`).expect(409);
      await a1.delete(`/api/monitoring-readings/abc`).expect(404);
      await queue.idle();
    });

    it('每位健管师每分钟最多 60 条，超出 429', async () => {
      const a3 = await as(f.users.managerA3);
      const body = { metric: 'heart_rate', value: 70, measuredAt: new Date().toISOString() };
      for (let i = 0; i < 60; i++) {
        await a3.post(`/api/clients/${f.clients.a3}/monitoring-readings`).send(body).expect(201);
      }
      await a3.post(`/api/clients/${f.clients.a3}/monitoring-readings`).send(body).expect(429);
      await queue.idle();
    });
  });

  // ---------- 跟进清单 ----------

  describe('跟进清单', () => {
    let critical: FollowUpItem;

    it('录入一条危急读数：生成危急指标（1 级）和状态变红（2 级），按严重程度排序', async () => {
      const a1 = await as(f.users.managerA1);
      await a1
        .post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`)
        .send({ metric: 'sbp', value: 186, measuredAt: new Date().toISOString() })
        .expect(201);
      await queue.idle();
      const res = followUpListResponseSchema.parse(
        (await a1.get('/api/follow-ups').expect(200)).body,
      );
      const mine = res.items.filter((i) => i.clientId === f.clients.a1[1]);
      expect(mine.map((i) => [i.kind, i.severity])).toEqual([
        ['critical', 1],
        ['status_red', 2],
      ]);
      expect(mine[0]).toMatchObject({
        metric: 'sbp',
        clientName: '测试客户 A1-2',
        basis: { value: 186, unit: 'mmHg', rule: { comparator: 'gte', value: 180 } },
        carriedDays: 0,
      });
      expect(res.openCount).toBe(res.items.length);
      critical = mine[0]!;
    });

    it('同一项未处理时不重复生成，只更新最近一次触发的时间和依据', async () => {
      const a1 = await as(f.users.managerA1);
      await a1
        .post(`/api/clients/${f.clients.a1[1]}/monitoring-readings`)
        .send({ metric: 'sbp', value: 192, measuredAt: new Date().toISOString() })
        .expect(201);
      await queue.idle();
      const items = (await a1.get(`/api/follow-ups?clientId=${f.clients.a1[1]}`).expect(200)).body
        .items as FollowUpItem[];
      const crit = items.filter((i) => i.kind === 'critical');
      expect(crit).toHaveLength(1);
      expect(crit[0]!.id).toBe(critical.id);
      expect(crit[0]!.basis).toMatchObject({ value: 192 });
      expect(Date.parse(crit[0]!.lastTriggeredAt)).toBeGreaterThan(
        Date.parse(critical.lastTriggeredAt),
      );
      const events = await owner
        .selectFrom('follow_up_events')
        .select('action')
        .where('item_id', '=', critical.id)
        .orderBy('id')
        .execute();
      expect(events.map((e) => e.action)).toEqual(['created', 'retriggered']);
    });

    it('别人的清单看不到；clientId 是别人的客户 → 404；机构管理员、运营商、平台 → 404', async () => {
      const a2 = await as(f.users.managerA2);
      const res = await a2.get('/api/follow-ups').expect(200);
      expect(res.body.items.some((i: FollowUpItem) => i.id === critical.id)).toBe(false);
      await a2.get(`/api/follow-ups?clientId=${f.clients.a1[1]}`).expect(404);
      const b1 = await as(f.users.managerB1);
      await b1.get(`/api/follow-ups?clientId=${f.clients.a1[1]}`).expect(404);
      for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
        const agent = await as(u);
        await agent.get('/api/follow-ups').expect(404);
      }
    });

    it('PATCH：别人的跟进项 → 404；危急类不能忽略 → 400', async () => {
      for (const u of [f.users.managerB1, f.users.managerA2, f.users.orgAdminA, f.users.platform]) {
        const agent = await as(u);
        await agent.patch(`/api/follow-ups/${critical.id}`).send({ action: 'done' }).expect(404);
      }
      const a1 = await as(f.users.managerA1);
      await a1
        .patch(`/api/follow-ups/${critical.id}`)
        .send({ action: 'dismiss', dismissReason: 'data_error' })
        .expect(400);
    });

    it('处理：已处理（方式和备注）→ 重新打开；暂缓按健管师时区到那天 0 点，到期前不在今日清单里', async () => {
      const a1 = await as(f.users.managerA1);
      const done = await a1
        .patch(`/api/follow-ups/${critical.id}`)
        .send({ action: 'done', resolution: 'called', note: '已电话联系，建议复测' })
        .expect(200);
      expect(done.body.item).toMatchObject({ status: 'done', resolution: 'called' });
      // 已处理的再暂缓 → 409
      await a1
        .patch(`/api/follow-ups/${critical.id}`)
        .send({ action: 'snooze', snoozeDays: 1 })
        .expect(409);
      await a1.patch(`/api/follow-ups/${critical.id}`).send({ action: 'reopen' }).expect(200);

      const tz = 'Asia/Shanghai';
      const res = await a1
        .patch(`/api/follow-ups/${critical.id}?tz=${encodeURIComponent(tz)}`)
        .send({ action: 'snooze', snoozeDays: 3 })
        .expect(200);
      const today = localDate(new Date(), tz);
      expect(res.body.item.snoozeUntil).toBe(zonedDayStart(addDays(today, 3), tz).toISOString());
      const now = await a1.get(`/api/follow-ups?tz=${encodeURIComponent(tz)}`).expect(200);
      expect(now.body.date).toBe(today);
      expect(now.body.items.some((i: FollowUpItem) => i.id === critical.id)).toBe(false);
      const later = await a1
        .get(`/api/follow-ups?tz=${encodeURIComponent(tz)}&date=${addDays(today, 3)}`)
        .expect(200);
      const back = later.body.items.find((i: FollowUpItem) => i.id === critical.id);
      expect(back).toMatchObject({ status: 'snoozed', carriedDays: 3 });
      await a1.get('/api/follow-ups?tz=Mars%2FOlympus').expect(400);
    });

    it('“今日”按账号设置的时区（优先于浏览器时区）', async () => {
      const a1 = await as(f.users.managerA1);
      await a1.patch('/api/auth/me').send({ timeZone: 'Mars/Olympus' }).expect(400);
      // 只能改自己的时区：请求体里带 userId 或其他字段一律 400，任何人的时区都不变
      await a1
        .patch('/api/auth/me')
        .send({ timeZone: 'Asia/Tokyo', userId: f.users.managerA2.id })
        .expect(400);
      await a1
        .patch('/api/auth/me')
        .send({ timeZone: 'Asia/Tokyo', role: 'platform_admin' })
        .expect(400);
      const zones = await owner
        .selectFrom('users')
        .select(['id', 'timezone'])
        .where('id', 'in', [f.users.managerA1.id, f.users.managerA2.id])
        .execute();
      expect(zones.map((z) => z.timezone)).toEqual([null, null]);
      await a1.patch('/api/auth/me').send({ timeZone: 'Pacific/Kiritimati' }).expect(204);
      const res = await a1.get('/api/follow-ups?tz=America%2FLos_Angeles').expect(200);
      expect(res.body).toMatchObject({
        timeZone: 'Pacific/Kiritimati',
        date: localDate(new Date(), 'Pacific/Kiritimati'),
      });
      await a1.patch('/api/auth/me').send({ timeZone: null }).expect(204);
    });

    it('客户转给别的健管师：未处理的跟进项跟着走，原健管师读不到、改不了', async () => {
      const a1 = await as(f.users.managerA1);
      await a1.patch(`/api/follow-ups/${critical.id}`).send({ action: 'reopen' }).expect(200);
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[1])
        .execute();
      try {
        await a1.patch(`/api/follow-ups/${critical.id}`).send({ action: 'done' }).expect(404);
        const mine = await a1.get('/api/follow-ups').expect(200);
        expect(mine.body.items.some((i: FollowUpItem) => i.clientId === f.clients.a1[1])).toBe(
          false,
        );
        const a2 = await as(f.users.managerA2);
        const theirs = await a2.get(`/api/follow-ups?clientId=${f.clients.a1[1]}`).expect(200);
        expect(theirs.body.items.map((i: FollowUpItem) => i.id)).toContain(critical.id);
      } finally {
        await owner
          .updateTable('clients')
          .set({ manager_id: f.users.managerA1.id })
          .where('id', '=', f.clients.a1[1])
          .execute();
      }
    });
  });

  // ---------- 核对和更正触发重算 ----------

  describe('更正报告后重算', () => {
    it('空腹血糖更正为高于报告参考范围：代谢由绿变黄，依据写明数值和参考范围，跟进清单出现“状态变差”', async () => {
      const { reportId, indicatorIds } = await addReport(f.clients.a2, 20, [
        { code: 'fpg', value: 5.2, unit: 'mmol/L', low: 3.9, high: 6.1 },
      ]);
      const a2 = await as(f.users.managerA2);
      await a2.get(`/api/clients/${f.clients.a2}/twin`).expect(200);
      await queue.idle();
      await a2
        .post(`/api/reports/${reportId}/indicators/${indicatorIds[0]}/correct`)
        .send({ rawValue: '6.8', rawUnit: 'mmol/L', refText: '3.9-6.1' })
        .expect(200);
      expect(queue.jobs.at(-1)?.data).toEqual({
        type: 'client',
        clientId: f.clients.a2,
        trigger: 'correction',
      });
      await queue.idle();
      const view = twinResponseSchema.parse(
        (await a2.get(`/api/clients/${f.clients.a2}/twin`).expect(200)).body,
      );
      const metabolic = view.domains.find((d) => d.domain === 'metabolic')!;
      expect(metabolic).toMatchObject({ level: 'yellow', previousLevel: 'green' });
      expect(metabolic.computed!.basis[0]).toMatchObject({
        metric: 'fpg',
        value: 6.8,
        source: 'report',
        refLow: 3.9,
        refHigh: 6.1,
        outcome: 'yellow',
      });
      const items = (await a2.get('/api/follow-ups').expect(200)).body.items as FollowUpItem[];
      expect(items.map((i) => [i.kind, i.domain])).toContainEqual(['status_worsened', 'metabolic']);
    });
  });

  // ---------- 时间轴 ----------

  describe('GET /api/clients/:id/twin/timeline', () => {
    it('健管师看到状态变化、跟进、更正等事件，可以按类型筛选、分页', async () => {
      const a2 = await as(f.users.managerA2);
      const res = twinTimelineResponseSchema.parse(
        (await a2.get(`/api/clients/${f.clients.a2}/twin/timeline`).expect(200)).body,
      );
      const types = new Set(res.events.map((e) => e.type));
      for (const t of ['report', 'correction', 'status_change', 'follow_up'] as const)
        expect(types, t).toContain(t);
      // 更正只说哪一项、谁、何时，不带数值
      const correction = res.events.find((e) => e.type === 'correction')!;
      expect(JSON.stringify(correction)).not.toContain('6.8');

      const only = await a2
        .get(`/api/clients/${f.clients.a2}/twin/timeline?types=status_change`)
        .expect(200);
      expect(new Set(only.body.events.map((e: { type: string }) => e.type))).toEqual(
        new Set(['status_change']),
      );
      const page = await a2.get(`/api/clients/${f.clients.a2}/twin/timeline?limit=1`).expect(200);
      expect(page.body.events).toHaveLength(1);
      expect(page.body.nextBefore).toBe(page.body.events[0].at);
      const next = await a2
        .get(
          `/api/clients/${f.clients.a2}/twin/timeline?limit=1&before=${encodeURIComponent(page.body.nextBefore)}`,
        )
        .expect(200);
      expect(Date.parse(next.body.events[0].at)).toBeLessThan(Date.parse(page.body.nextBefore));
      await a2.get(`/api/clients/${f.clients.a2}/twin/timeline?types=bogus`).expect(400);
    });

    it('机构管理员的响应里没有产物、专家、跟进类事件；别人的客户 → 404', async () => {
      const org = await as(f.users.orgAdminA);
      const res = await org
        .get(
          `/api/clients/${f.clients.a2}/twin/timeline?types=follow_up,artifact,expert,status_change`,
        )
        .expect(200);
      const types = new Set(res.body.events.map((e: { type: string }) => e.type));
      expect(types.has('follow_up') || types.has('artifact') || types.has('expert')).toBe(false);
      expect(types).toContain('status_change');
      for (const u of [
        f.users.managerA1,
        f.users.managerB1,
        f.users.orgAdminA2,
        f.users.operatorAdminA,
        f.users.operatorAdminB,
        f.users.platform,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a2}/twin/timeline`).expect(404);
      }
    });
  });

  // ---------- 状态规则 ----------

  describe('孪生状态规则', () => {
    it('所有后台角色和健管师都能读，不含任何客户数据；无登录 → 401', async () => {
      for (const u of [
        f.users.managerA1,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const agent = await as(u);
        const res = await agent.get('/api/twin-status-rules').expect(200);
        const body = twinRulesResponseSchema.parse(res.body);
        expect(body.rules.length).toBeGreaterThan(10);
        expect(JSON.stringify(res.body)).not.toContain(f.clients.a1[0]);
      }
      await request(app.getHttpServer()).get('/api/twin-status-rules').expect(401);
    });

    const newRule = {
      domain: 'sleep',
      metric: 'sleep_hours',
      source: 'monitoring',
      method: 'threshold',
      comparator: 'lt',
      value: 5,
      unit: 'h',
      windowDays: 7,
      level: 'yellow',
    };

    it('运营商、机构管理员、健管师 → 403', async () => {
      const id = (
        await owner.selectFrom('twin_status_rules').select('id').executeTakeFirstOrThrow()
      ).id as string;
      for (const u of [f.users.operatorAdminA, f.users.orgAdminA, f.users.managerA1]) {
        const agent = await as(u);
        await agent.post('/api/admin/twin-status-rules').send(newRule).expect(403);
        await agent
          .patch(`/api/admin/twin-status-rules/${id}`)
          .send({ enabled: false })
          .expect(403);
        await agent.post('/api/admin/twin-status-rules/reset').expect(403);
      }
    });

    it('平台管理员新增规则：版本号加一，所有客户在后台按新规则重算，不生成跟进项', async () => {
      const p = await as(f.users.platform);
      const before = twinRulesResponseSchema.parse(
        (await p.get('/api/twin-status-rules').expect(200)).body,
      );
      const followUpsBefore = await owner.selectFrom('follow_up_items').select('id').execute();
      // A3 的客户最近一周心率平均 70 → 心血管绿；加一条“睡眠时长 < 5 小时为黄”的规则
      await addReadings(f.clients.a3, 'sleep_hours', 'h', [
        [1, 4],
        [2, 4.5],
      ]);
      const res = await p.post('/api/admin/twin-status-rules').send(newRule).expect(201);
      expect(res.body.rule).toMatchObject({ metric: 'sleep_hours', value: 5, enabled: true });
      expect(queue.jobs.at(-1)?.data).toEqual({ type: 'all', trigger: 'rules_changed' });
      await queue.idle();

      const after = twinRulesResponseSchema.parse(
        (await p.get('/api/twin-status-rules').expect(200)).body,
      );
      expect(after.version).toBe(before.version + 1);
      const sleep = await owner
        .selectFrom('twin_status_history')
        .select(['level', 'trigger', 'rules_version'])
        .where('client_id', '=', f.clients.a3)
        .where('domain', '=', 'sleep')
        .orderBy('created_at', 'desc')
        .executeTakeFirstOrThrow();
      expect(sleep).toEqual({
        level: 'yellow',
        trigger: 'rules_changed',
        rules_version: after.version,
      });
      expect(await owner.selectFrom('follow_up_items').select('id').execute()).toEqual(
        followUpsBefore,
      );
      // 时间轴记一条“规则更新后重新计算”
      const a3 = await as(f.users.managerA3);
      const tl = await a3
        .get(`/api/clients/${f.clients.a3}/twin/timeline?types=status_change`)
        .expect(200);
      expect(tl.body.events[0]).toMatchObject({
        domain: 'sleep',
        to: 'yellow',
        trigger: 'rules_changed',
      });
    });

    it('阈值超出合理范围、单位不跟目录、形状不对 → 400；重复 → 409；修改不存在的 → 404', async () => {
      const p = await as(f.users.platform);
      for (const body of [
        { ...newRule, value: 30 },
        { ...newRule, unit: 'min' },
        { ...newRule, method: 'out_of_reference' },
        { ...newRule, domain: 'metabolic' },
      ]) {
        await p.post('/api/admin/twin-status-rules').send(body).expect(400);
      }
      await p.post('/api/admin/twin-status-rules').send(newRule).expect(409);
      const rule = await owner
        .selectFrom('twin_status_rules')
        .select('id')
        .where('metric', '=', 'sleep_hours')
        .where('method', '=', 'threshold')
        .executeTakeFirstOrThrow();
      await p.patch(`/api/admin/twin-status-rules/${rule.id}`).send({ value: -1 }).expect(400);
      await p.patch(`/api/admin/twin-status-rules/${rule.id}`).send({}).expect(400);
      const ok = await p
        .patch(`/api/admin/twin-status-rules/${rule.id}`)
        .send({ value: 4.5, enabled: false })
        .expect(200);
      expect(ok.body.rule).toMatchObject({ value: 4.5, enabled: false });
      await p
        .patch('/api/admin/twin-status-rules/00000000-0000-4000-8000-000000000000')
        .send({ enabled: true })
        .expect(404);
      await queue.idle();
    });

    it('恢复为默认值：修改记录标为 reset，新加的规则没有了', async () => {
      const p = await as(f.users.platform);
      const res = await p.post('/api/admin/twin-status-rules/reset').expect(200);
      const body = twinRulesResponseSchema.parse(res.body);
      expect(body.rules.some((r) => r.metric === 'sleep_hours' && r.method === 'threshold')).toBe(
        false,
      );
      const last = await owner
        .selectFrom('twin_status_rule_events')
        .select('action')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(last.action).toBe('reset');
      await queue.idle();
    });

    it('平台修改危急阈值后同样批量重算（thresholds_changed）', async () => {
      const p = await as(f.users.platform);
      const t = await owner
        .selectFrom('critical_thresholds')
        .select('id')
        .where('metric', '=', 'uric_acid')
        .executeTakeFirstOrThrow();
      await p.patch(`/api/critical-thresholds/${t.id}`).send({ value: 560 }).expect(200);
      expect(queue.jobs.at(-1)?.data).toEqual({ type: 'all', trigger: 'thresholds_changed' });
      await queue.idle();
    });
  });

  // ---------- 统计 ----------

  describe('GET /api/twin-stats', () => {
    const ROW_KEYS = [
      'date',
      'dismissed',
      'done',
      'followUpsCreated',
      'opens',
      'operatorId',
      'operatorName',
      'reopened',
      'snoozed',
      'summaries',
    ];

    it('健管师、机构管理员 → 403', async () => {
      for (const u of [f.users.managerA1, f.users.orgAdminA]) {
        const agent = await as(u);
        await agent.get('/api/twin-stats').expect(403);
      }
    });

    it('运营商只看本协会（请求别的协会也只返回本协会），平台看全部；只有汇总数字', async () => {
      // 协会 B 也打开一次孪生
      const b1 = await as(f.users.managerB1);
      await b1.get(`/api/clients/${f.clients.b1}/twin`).expect(200);
      await queue.idle();

      const opA = await as(f.users.operatorAdminA);
      const a = twinStatsResponseSchema.parse(
        (await opA.get(`/api/twin-stats?operatorId=${f.operatorB}`).expect(200)).body,
      );
      expect(a.scope).toBe('operator');
      expect(a.operatorId).toBeNull();
      expect(a.totals.opens).toBeGreaterThan(0);
      expect(a.totals.followUpsCreated).toBeGreaterThan(0);
      expect(a.totals.done).toBeGreaterThan(0);
      expect(a.totals.snoozed).toBeGreaterThan(0);
      expect(a.rows.every((r) => r.operatorId === null)).toBe(true);

      const opB = await as(f.users.operatorAdminB);
      const b = twinStatsResponseSchema.parse((await opB.get('/api/twin-stats').expect(200)).body);
      expect(b.totals.followUpsCreated).toBe(0);
      expect(b.totals.opens).toBe(1);

      const p = await as(f.users.platform);
      const all = await p.get('/api/twin-stats').expect(200);
      const parsed = twinStatsResponseSchema.parse(all.body);
      expect(new Set(parsed.rows.map((r) => r.operatorId))).toEqual(
        new Set([f.operatorA, f.operatorB]),
      );
      for (const row of all.body.rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      const text = JSON.stringify(all.body);
      for (const id of [f.users.managerA1.id, f.clients.a1[0], f.clients.a1[1]])
        expect(text).not.toContain(id);
      const onlyB = twinStatsResponseSchema.parse(
        (await p.get(`/api/twin-stats?operatorId=${f.operatorB}`).expect(200)).body,
      );
      expect(new Set(onlyB.rows.map((r) => r.operatorId))).toEqual(new Set([f.operatorB]));
      await p.get('/api/twin-stats?from=2026-02-30').expect(400);
    });
  });

  it('打开孪生不调用大模型、不写任何客户数据到统计表', async () => {
    const rows = await sql<{ n: number }>`select count(*)::int as n from llm_usage`.execute(owner);
    expect(rows.rows[0]!.n).toBe(0);
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'twin_usage_daily'
    `.execute(owner);
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['day', 'opens', 'operator_id']);
  });

  it('孪生主视图的形状（健管师）', async () => {
    const a1 = await as(f.users.managerA1);
    const res = await a1.get(`/api/clients/${f.clients.a1[0]}/twin`).expect(200);
    const view: TwinResponse = twinResponseSchema.strict().parse(res.body);
    expect(view.forecasts.length).toBeGreaterThan(0);
  });

  // ---------- 工作台第 3 步新增的两个只读接口 ----------

  describe('GET /api/twin/levels（左侧栏客户状态圆点）', () => {
    it('只列自己的客户，等级是四个方面里最严重的，和孪生主视图一致；手动调整优先', async () => {
      const a1 = await as(f.users.managerA1);
      const res = twinLevelsResponseSchema.parse(
        (await a1.get('/api/twin/levels').expect(200)).body,
      );
      expect(res.clients.map((c) => c.clientId).sort()).toEqual([...f.clients.a1].sort());
      for (const c of res.clients) {
        const view = twinResponseSchema.parse(
          (await a1.get(`/api/clients/${c.clientId}/twin`).expect(200)).body,
        );
        expect(c.level).toBe(worstTwinLevel(view.domains.map((d) => d.level)));
      }
      // 只有颜色等级，不带依据和数值
      expect(Object.keys(res.clients[0]!).sort()).toEqual(['clientId', 'level']);

      const domains = ['metabolic', 'cardiovascular', 'sleep', 'weight'] as const;
      for (const domain of domains)
        await a1
          .post(`/api/clients/${f.clients.a1[1]}/twin/status`)
          .send({ domain, level: 'green', reason: '合成理由：已电话确认' })
          .expect(200);
      try {
        const after = twinLevelsResponseSchema.parse(
          (await a1.get('/api/twin/levels').expect(200)).body,
        );
        expect(after.clients.find((c) => c.clientId === f.clients.a1[1])?.level).toBe('green');
      } finally {
        for (const domain of domains)
          await a1.delete(`/api/clients/${f.clients.a1[1]}/twin/status/${domain}`).expect(200);
      }
    });

    it('跨租户：别的健管师的列表里没有这些客户；机构管理员、运营商、平台 → 404；未登录 → 401', async () => {
      for (const u of [f.users.managerB1, f.users.managerA2, f.users.managerA3]) {
        const agent = await as(u);
        const res = twinLevelsResponseSchema.parse(
          (await agent.get('/api/twin/levels').expect(200)).body,
        );
        for (const id of f.clients.a1) expect(res.clients.map((c) => c.clientId)).not.toContain(id);
      }
      for (const u of [f.users.orgAdminA, f.users.operatorAdminA, f.users.platform]) {
        const agent = await as(u);
        await agent.get('/api/twin/levels').expect(404);
      }
      await request(app.getHttpServer()).get('/api/twin/levels').expect(401);
    });
  });

  describe('GET /api/clients/:id/manual-readings（自己手动录入的读数）', () => {
    it('只列自己手动录入的，不含合成数据；可以删除；别人的客户、机构管理员 → 404', async () => {
      const a1 = await as(f.users.managerA1);
      const created = await a1
        .post(`/api/clients/${f.clients.a1[0]}/monitoring-readings`)
        .send({ metric: 'weight', value: 64.5, measuredAt: new Date().toISOString() })
        .expect(201);
      await queue.idle();
      await addReadings(f.clients.a1[0], 'weight', 'kg', [[1, 64.8]]);
      const list = monitoringReadingListResponseSchema.parse(
        (await a1.get(`/api/clients/${f.clients.a1[0]}/manual-readings`).expect(200)).body,
      );
      expect(list.readings.map((r) => r.id)).toContain(created.body.reading.id);
      expect(list.readings.every((r) => r.source === 'manual' && r.deletable)).toBe(true);

      for (const u of [
        f.users.managerB1,
        f.users.managerA2,
        f.users.orgAdminA,
        f.users.operatorAdminA,
        f.users.platform,
      ]) {
        const agent = await as(u);
        await agent.get(`/api/clients/${f.clients.a1[0]}/manual-readings`).expect(404);
      }
      await a1.get('/api/clients/not-a-uuid/manual-readings').expect(404);

      await a1.delete(`/api/monitoring-readings/${created.body.reading.id}`).expect(204);
      await queue.idle();
      const after = monitoringReadingListResponseSchema.parse(
        (await a1.get(`/api/clients/${f.clients.a1[0]}/manual-readings`).expect(200)).body,
      );
      expect(after.readings.map((r) => r.id)).not.toContain(created.body.reading.id);
    });

    it('客户转给别的健管师：新健管师看不到原健管师录入的（只列自己录入的），原健管师 → 404', async () => {
      const a1 = await as(f.users.managerA1);
      const created = await a1
        .post(`/api/clients/${f.clients.a1[0]}/monitoring-readings`)
        .send({ metric: 'heart_rate', value: 72, measuredAt: new Date().toISOString() })
        .expect(201);
      await queue.idle();
      await owner
        .updateTable('clients')
        .set({ manager_id: f.users.managerA2.id })
        .where('id', '=', f.clients.a1[0])
        .execute();
      try {
        await a1.get(`/api/clients/${f.clients.a1[0]}/manual-readings`).expect(404);
        const a2 = await as(f.users.managerA2);
        const theirs = monitoringReadingListResponseSchema.parse(
          (await a2.get(`/api/clients/${f.clients.a1[0]}/manual-readings`).expect(200)).body,
        );
        expect(theirs.readings).toEqual([]);
      } finally {
        await owner
          .updateTable('clients')
          .set({ manager_id: f.users.managerA1.id })
          .where('id', '=', f.clients.a1[0])
          .execute();
      }
      await a1.delete(`/api/monitoring-readings/${created.body.reading.id}`).expect(204);
      await queue.idle();
    });
  });
});
