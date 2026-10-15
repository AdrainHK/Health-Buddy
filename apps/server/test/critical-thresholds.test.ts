import { DEFAULT_CRITICAL_RULES } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/** 危急指标阈值接口：全平台一套，所有后台角色和健管师能读，只有平台管理员能改（Q12）。 */
describe('危急指标阈值接口', () => {
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

  const newRule = {
    metric: 'creatinine',
    comparator: 'gte',
    value: 500,
    level: 'attention',
    enabled: true,
  };

  it('未登录不能访问', async () => {
    await request(app.getHttpServer()).get('/api/critical-thresholds').expect(401);
    await request(app.getHttpServer()).post('/api/critical-thresholds').send(newRule).expect(401);
  });

  it('各级账号都能读到同一套阈值', async () => {
    for (const u of [
      f.users.platform,
      f.users.operatorAdminA,
      f.users.orgAdminA,
      f.users.managerB1,
    ]) {
      const agent = await loginAs(app, u.email);
      const res = await agent.get('/api/critical-thresholds').expect(200);
      expect(res.body.thresholds, u.email).toHaveLength(DEFAULT_CRITICAL_RULES.length);
      const sbp = res.body.thresholds.find(
        (t: { metric: string; comparator: string }) => t.metric === 'sbp' && t.comparator === 'gte',
      );
      expect(sbp).toMatchObject({ value: 180, level: 'urgent', enabled: true });
    }
  });

  it('平台管理员能新增、修改、停用，并记录操作人', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    const created = await agent.post('/api/critical-thresholds').send(newRule).expect(201);
    expect(created.body.threshold).toMatchObject({ ...newRule, updatedBy: f.users.platform.id });

    const id = created.body.threshold.id as string;
    const patched = await agent
      .patch(`/api/critical-thresholds/${id}`)
      .send({ value: 600, enabled: false })
      .expect(200);
    expect(patched.body.threshold).toMatchObject({ value: 600, enabled: false });

    const events = await owner
      .selectFrom('critical_threshold_events')
      .selectAll()
      .where('threshold_id', '=', id)
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.action)).toEqual(['created', 'updated']);
    expect(events.every((e) => e.actor_id === f.users.platform.id)).toBe(true);
  });

  it('协会管理员、机构管理员和健管师不能改，返回“不存在”', async () => {
    const [rule] = await owner.selectFrom('critical_thresholds').select('id').execute();
    if (!rule) throw new Error('no rule');
    const before = await owner.selectFrom('critical_threshold_events').select('id').execute();
    for (const u of [f.users.operatorAdminA, f.users.orgAdminA, f.users.managerA1]) {
      const agent = await loginAs(app, u.email);
      await agent.post('/api/critical-thresholds').send(newRule).expect(404);
      await agent.patch(`/api/critical-thresholds/${rule.id}`).send({ value: 1 }).expect(404);
      await agent.post('/api/critical-thresholds/reset').expect(404);
    }
    const after = await owner.selectFrom('critical_threshold_events').select('id').execute();
    expect(after).toHaveLength(before.length);
  });

  it('阈值超出合理范围被拒绝', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    await agent
      .post('/api/critical-thresholds')
      .send({ ...newRule, metric: 'sbp', comparator: 'gt', value: 1800 })
      .expect(400);
    const sbp = await owner
      .selectFrom('critical_thresholds')
      .select('id')
      .where('metric', '=', 'sbp')
      .where('comparator', '=', 'gte')
      .executeTakeFirstOrThrow();
    await agent.patch(`/api/critical-thresholds/${sbp.id}`).send({ value: 1800 }).expect(400);
    await agent.patch(`/api/critical-thresholds/${sbp.id}`).send({}).expect(400);
  });

  it('同一指标同一方向重复新增返回 409', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    const res = await agent
      .post('/api/critical-thresholds')
      .send({ ...newRule, metric: 'sbp', comparator: 'gte', value: 170 })
      .expect(409);
    expect(res.body).toEqual({ error: 'conflict' });
  });

  it('不存在或格式不对的 id 返回“不存在”', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    await agent
      .patch('/api/critical-thresholds/00000000-0000-4000-8000-000000000000')
      .send({ value: 100 })
      .expect(404);
    await agent.patch('/api/critical-thresholds/not-a-uuid').send({ value: 100 }).expect(404);
  });

  it('恢复为默认值', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    await agent.post('/api/critical-thresholds').send(newRule).expect(201);
    const before = await owner.selectFrom('critical_threshold_events').select('id').execute();
    const res = await agent.post('/api/critical-thresholds/reset').expect(200);
    expect(res.body.thresholds).toHaveLength(DEFAULT_CRITICAL_RULES.length);
    expect(res.body.thresholds.some((t: { metric: string }) => t.metric === 'creatinine')).toBe(
      false,
    );
    // 删掉的和重新写入的规则都有记录，操作人是平台管理员
    const seen = new Set(before.map((e) => e.id));
    const events = (
      await owner.selectFrom('critical_threshold_events').selectAll().execute()
    ).filter((e) => !seen.has(e.id));
    expect(events.filter((e) => e.action === 'deleted')).toHaveLength(
      DEFAULT_CRITICAL_RULES.length + 1,
    );
    expect(events.filter((e) => e.action === 'created')).toHaveLength(
      DEFAULT_CRITICAL_RULES.length,
    );
    expect(events.every((e) => e.actor_id === f.users.platform.id)).toBe(true);
  });
});

describe('技能列表接口', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('健管师能看到示例技能', async () => {
    const agent = await loginAs(app, f.users.managerA1.email);
    const res = await agent.get('/api/skills').expect(200);
    expect(res.body.skills).toContainEqual(
      expect.objectContaining({ id: 'client-recent-summary', requiresClient: true }),
    );
  });

  it('其他角色返回“不存在”，未登录返回 401', async () => {
    await request(app.getHttpServer()).get('/api/skills').expect(401);
    for (const u of [f.users.platform, f.users.operatorAdminA, f.users.orgAdminA]) {
      const agent = await loginAs(app, u.email);
      await agent.get('/api/skills').expect(404);
    }
  });
});
