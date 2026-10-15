import type { INestApplication } from '@nestjs/common';
import { MockProvider } from '@health-buddy/ai-engine';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { createTestApp, loginAs } from './http.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';

/** 把 SSE 响应体解析成事件数组。 */
function parseSse(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)) as unknown);
}

describe('大模型网关接入', () => {
  const owner = ownerDb();
  let f: Fixtures;
  let app: INestApplication;
  let unconfigured: INestApplication;
  let badKey: INestApplication;
  const provider = new MockProvider('openai', {
    chunks: ['Hello', ' there'],
    usage: { inputTokens: 20, outputTokens: 5 },
  });

  beforeAll(async () => {
    f = await seedFixtures(owner);
    app = await createTestApp({}, { llmProviders: { openai: provider } });
    unconfigured = await createTestApp();
    badKey = await createTestApp(
      {},
      {
        llmProviders: {
          openai: new MockProvider('openai', {
            chunks: [],
            failWith: Object.assign(new Error('Incorrect API key provided'), {
              status: 401,
              code: 'invalid_api_key',
            }),
          }),
        },
      },
    );
  });

  beforeEach(async () => {
    await owner.deleteFrom('llm_usage').execute();
  });

  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    await badKey.close();
    await owner.destroy();
  });

  it('平台管理员可以流式调用，并记录用量', async () => {
    const agent = await loginAs(app, f.users.platform.email);
    const res = await agent.post('/api/ai/smoke').expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(parseSse(res.text)).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' there' },
      {
        type: 'done',
        finishReason: 'complete',
        usage: { inputTokens: 20, outputTokens: 5 },
        model: 'gpt-6-astra',
      },
    ]);

    const rows = await owner.selectFrom('llm_usage').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: f.users.platform.id,
      operator_id: null,
      route: 'smoke',
      provider: 'openai',
      model: 'gpt-6-astra',
      input_tokens: 20,
      output_tokens: 5,
      outcome: 'complete',
    });
  });

  it('其他角色调用返回“不存在”，也不会真的调用大模型', async () => {
    const before = provider.calls.length;
    for (const email of [
      f.users.managerA1.email,
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
    ]) {
      const agent = await loginAs(app, email);
      const res = await agent.post('/api/ai/smoke').expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
    expect(provider.calls.length).toBe(before);
    await request(app.getHttpServer()).post('/api/ai/smoke').expect(401);
  });

  it('没有配置密钥时返回 not_configured，并记录一次失败', async () => {
    const agent = await loginAs(unconfigured, f.users.platform.email);
    const res = await agent.post('/api/ai/smoke').expect(200);
    expect(parseSse(res.text)).toEqual([{ type: 'error', kind: 'not_configured' }]);
    const rows = await owner.selectFrom('llm_usage').select(['outcome', 'error_type']).execute();
    expect(rows).toEqual([{ outcome: 'error', error_type: 'not_configured' }]);
  });

  it('厂商报错时返回状态码和错误码，不返回厂商的错误信息', async () => {
    const agent = await loginAs(badKey, f.users.platform.email);
    const res = await agent.post('/api/ai/smoke').expect(200);
    expect(parseSse(res.text)).toEqual([
      { type: 'error', kind: 'provider_error', status: 401, code: 'invalid_api_key' },
    ]);
    expect(res.text).not.toContain('Incorrect API key');
  });

  describe('用量表的行级安全', () => {
    let db: Kysely<Database>;
    beforeAll(() => {
      db = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 1 }),
        }),
      });
    });
    afterAll(() => db.destroy());

    const row = (userId: string, operatorId: string | null) => ({
      user_id: userId,
      operator_id: operatorId,
      route: 'chat',
      provider: 'openai' as const,
      model: 'gpt-6-astra',
      input_tokens: 1,
      output_tokens: 1,
      duration_ms: 1,
      outcome: 'complete' as const,
    });

    it('运营商只看到本协会的用量，健管师只看到自己的', async () => {
      await owner
        .insertInto('llm_usage')
        .values([
          row(f.users.managerA1.id, f.operatorA),
          row(f.users.managerA2.id, f.operatorA),
          row(f.users.managerB1.id, f.operatorB),
        ])
        .execute();

      const opA = {
        userId: f.users.operatorAdminA.id,
        role: 'operator_admin' as const,
        operatorId: f.operatorA,
        orgId: null,
      };
      const seenByOp = await withTenant(db, opA, (trx) =>
        trx.selectFrom('llm_usage').select('operator_id').execute(),
      );
      expect(seenByOp.map((r) => r.operator_id)).toEqual([f.operatorA, f.operatorA]);

      const m1 = {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      };
      const seenByManager = await withTenant(db, m1, (trx) =>
        trx.selectFrom('llm_usage').select('user_id').execute(),
      );
      expect(seenByManager.map((r) => r.user_id)).toEqual([f.users.managerA1.id]);
    });

    it('平台管理员看到全部用量；用量记录写入后不能修改或删除', async () => {
      await owner
        .insertInto('llm_usage')
        .values([row(f.users.managerA1.id, f.operatorA), row(f.users.managerB1.id, f.operatorB)])
        .execute();
      const platform = {
        userId: f.users.platform.id,
        role: 'platform_admin' as const,
        operatorId: null,
        orgId: null,
      };
      const all = await withTenant(db, platform, (trx) =>
        trx.selectFrom('llm_usage').select('id').execute(),
      );
      expect(all).toHaveLength(2);

      const m1 = {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      };
      await expect(
        withTenant(db, m1, (trx) =>
          trx.updateTable('llm_usage').set({ input_tokens: 0 }).execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(db, m1, (trx) => trx.deleteFrom('llm_usage').execute()),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('不能替别人或别的协会记账', async () => {
      const m1 = {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      };
      for (const values of [
        row(f.users.managerA2.id, f.operatorA),
        row(f.users.managerA1.id, f.operatorB),
      ]) {
        await expect(
          withTenant(db, m1, (trx) => trx.insertInto('llm_usage').values(values).execute()),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
});
