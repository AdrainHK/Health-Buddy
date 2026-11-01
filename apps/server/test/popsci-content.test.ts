import { POPSCI_DEFAULT_RULES } from '@health-buddy/shared';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { insertDraft, insertTask, type Scope } from './work-fixtures.js';

type Agent = Awaited<ReturnType<typeof loginAs>>;

/**
 * M8 第 2 步：科普的合规检查、核对和确认把关（规格 2.1 第 7 条、2.3、3.3，验收 4、5、13、14）。
 * 科普产物由所有者直接插入（生成接线在第 2b 步）。全部是合成文字。
 */
describe('科普合规检查和审核', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let a1: Scope;
  let b1: Scope;

  const article = (body: string) => ({
    kind: 'popsci_article',
    title: '冬季怎样管理血压',
    sections: [{ heading: '规律作息', body }],
    summary: '',
  });

  const insertPopsci = async (scope: Scope, body: string) => {
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
        skill_id: 'popsci-article',
        kind: 'popsci_article',
        lineage_id: id,
        version: 1,
        status: 'draft',
        content: JSON.stringify({ professional: '', clientFacing: '' }),
        critical_flags: '[]',
        structured: JSON.stringify(article(body)),
      })
      .execute();
    return id;
  };

  const detail = async (agent: Agent, id: string) =>
    (await agent.get(`/api/artifacts/${id}`).expect(200)).body;
  const approve = async (agent: Agent, id: string) => {
    const { artifact } = await detail(agent, id);
    return agent
      .post(`/api/artifacts/${id}/approve`)
      .send({ version: artifact.version, contentHash: artifact.contentHash });
  };
  const ack = async (agent: Agent, id: string) => {
    const { artifact } = await detail(agent, id);
    return agent
      .post(`/api/artifacts/${id}/compliance-ack`)
      .send({ contentHash: artifact.contentHash });
  };
  const edit = async (agent: Agent, id: string, body: string) => {
    const { artifact } = await detail(agent, id);
    return agent.patch(`/api/artifacts/${id}`).send({
      version: artifact.version,
      contentHash: artifact.contentHash,
      content: { professional: '', clientFacing: '' },
      structured: article(body),
    });
  };
  const statusOf = async (id: string) =>
    (
      await owner
        .selectFrom('artifacts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    // 每个用例从默认规则（第 1 版）开始
    await owner.deleteFrom('content_rules').where('version', '>', 1).execute();
    a1 = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id };
    b1 = { operatorId: f.operatorB, orgId: f.orgB, managerId: f.users.managerB1.id };
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('验收 4：有“治愈”“100% 有效”时不能确认，标出位置和原因；改掉后可以确认', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insertPopsci(a1, '坚持这样做可以治愈，100%有效。');
    const res = await approve(m, id);
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['content_check_failed']);
    const { contentCheck } = await detail(m, id);
    expect(contentCheck.rulesVersion).toBe(1);
    expect(contentCheck.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'forbid',
          term: '治愈',
          location: { field: 'body', index: 0, item: null },
        }),
        expect.objectContaining({ ruleId: 'efficacy_promise', term: '100%有效' }),
      ]),
    );
    // 有禁止类时也不能勾选“已核对”
    expect((await ack(m, id)).status).toBe(409);

    const edited = await edit(m, id, '每天按时睡觉，适量活动。');
    expect(edited.status).toBe(200);
    expect(edited.body.contentCheck.hits).toEqual([]);
    expect((await approve(m, id)).status).toBe(200);
    expect(await statusOf(id)).toBe('approved');
  });

  it('验收 5：有“需要人工判断”的项目时不核对返回 content_check_pending；核对后可以确认，记下核对人', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insertPopsci(a1, '高血压人群每天少吃 2 克盐。');
    const res = await approve(m, id);
    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['content_check_pending']);

    const acked = await ack(m, id);
    expect(acked.status).toBe(200);
    expect(acked.body.contentCheck).toMatchObject({ ackedBy: f.users.managerA1.id });
    expect(acked.body.events.map((e: { action: string }) => e.action)).toContain('content_acked');

    // 内容一改，核对清空，要重新核对
    const edited = await edit(m, id, '高血压人群每天少吃 3 克盐。');
    expect(edited.body.contentCheck.ackedBy).toBeNull();
    expect((await approve(m, id)).body.reasons).toEqual(['content_check_pending']);
    await ack(m, id);
    expect((await approve(m, id)).status).toBe(200);
  });

  it('修改时结构不合规（换了类型、字段超长）返回 400，内容不变', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insertPopsci(a1, '每天按时睡觉。');
    const { artifact } = await detail(m, id);
    for (const structured of [
      { kind: 'community_post', paragraphs: ['x'], interaction: '' },
      { ...article('x'), title: '题'.repeat(61) },
    ]) {
      await m
        .patch(`/api/artifacts/${id}`)
        .send({
          version: 1,
          contentHash: artifact.contentHash,
          content: { professional: '', clientFacing: '' },
          structured,
        })
        .expect(400);
    }
    expect((await detail(m, id)).artifact.structured).toEqual(article('每天按时睡觉。'));
  });

  it('数据库第二道把关：绕过后端直接把科普产物改成已审核被拒绝；科普产物不能挂客户', async () => {
    const id = await insertPopsci(a1, '坚持这样做可以治愈。');
    const db = app.get<Db>(DB);
    const ctx = {
      userId: f.users.managerA1.id,
      role: 'manager' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    await expect(
      withTenant(db, ctx, (trx) =>
        trx.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // 写一条“没有命中”的结果后再改内容：数据库要求结果对应当前内容（指纹由数据库填写），
    // 内容变了就不放行。命中项本身的真实性由后端每次确认前按当前规则重算保证
    await withTenant(db, ctx, (trx) =>
      trx
        .insertInto('content_compliance_results')
        .values({
          artifact_id: id,
          operator_id: f.operatorA,
          org_id: f.orgA,
          manager_id: f.users.managerA1.id,
          rules_version: 1,
          hits: '[]',
        })
        .execute(),
    );
    await owner
      .updateTable('artifacts')
      .set({ structured: JSON.stringify(article('换了内容')) })
      .where('id', '=', id)
      .execute();
    await expect(
      withTenant(db, ctx, (trx) =>
        trx.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner
        .updateTable('artifacts')
        .set({ client_id: f.clients.a1[0] })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow();
  });

  it('验收 13：别人的科普产物上核对、确认、修改一律 404，数据不变', async () => {
    const id = await insertPopsci(b1, '高血压人群每天少吃 2 克盐。');
    const owner_ = await loginAs(app, f.users.managerB1.email);
    const { artifact } = await detail(owner_, id);
    for (const email of [f.users.managerA1.email, f.users.managerA2.email]) {
      const m = await loginAs(app, email);
      await m
        .post(`/api/artifacts/${id}/compliance-ack`)
        .send({ contentHash: artifact.contentHash })
        .expect(404);
      await m
        .post(`/api/artifacts/${id}/approve`)
        .send({ version: 1, contentHash: artifact.contentHash })
        .expect(404);
      await m
        .patch(`/api/artifacts/${id}`)
        .send({
          version: 1,
          contentHash: artifact.contentHash,
          content: { professional: '', clientFacing: '' },
          structured: article('改掉'),
        })
        .expect(404);
      await m.get(`/api/artifacts/${id}`).expect(404);
    }
    expect(await statusOf(id)).toBe('draft');
    const rows = await owner
      .selectFrom('content_compliance_results')
      .select('acked_by')
      .where('artifact_id', '=', id)
      .execute();
    expect(rows.every((r) => r.acked_by === null)).toBe(true);
    // 后台账号对健管师的产物接口一律 404
    for (const email of [f.users.orgAdminA.email, f.users.operatorAdminA.email]) {
      await (
        await loginAs(app, email)
      )
        .post(`/api/artifacts/${id}/compliance-ack`)
        .send({ contentHash: artifact.contentHash })
        .expect(404);
    }
    // 不是科普的产物不能“核对”
    const plain = await insertDraft(owner, a1, await insertTask(owner, a1));
    const m = await loginAs(app, f.users.managerA1.email);
    const { artifact: p } = await detail(m, plain);
    await m
      .post(`/api/artifacts/${plain}/compliance-ack`)
      .send({ contentHash: p.contentHash })
      .expect(404);
    expect((await detail(m, plain)).contentCheck).toBeNull();
  });

  it('套餐关闭“科普内容工厂”后，修改、核对、确认返回 403 plan_feature_disabled', async () => {
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
    await owner
      .insertInto('operator_plans')
      .values({ operator_id: f.operatorA, plan_id: (plan as { id: string }).id } as never)
      .execute();
    await owner
      .insertInto('user_plans')
      .values({ user_id: f.users.managerA1.id, plan_id: (plan as { id: string }).id } as never)
      .execute();
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insertPopsci(a1, '每天按时睡觉。');
    const res = await approve(m, id);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_feature_disabled');
    expect((await ack(m, id)).status).toBe(403);
    expect((await edit(m, id, '改了')).status).toBe(403);
  });

  it('规则：后台账号能读，只有平台能保存新版本；新版本对之后的检查生效；并发保存 409', async () => {
    for (const email of [f.users.orgAdminA.email, f.users.operatorAdminA.email]) {
      const body = (await (await loginAs(app, email)).get('/api/admin/content-rules').expect(200))
        .body;
      expect(body.version).toBe(1);
      await (
        await loginAs(app, email)
      )
        .put('/api/admin/content-rules')
        .send({ baseVersion: 1, rules: POPSCI_DEFAULT_RULES })
        .expect(403);
    }
    const m = await loginAs(app, f.users.managerA1.email);
    await m.get('/api/admin/content-rules').expect(403);
    await m
      .put('/api/admin/content-rules')
      .send({ baseVersion: 1, rules: POPSCI_DEFAULT_RULES })
      .expect(403);
    await request(app.getHttpServer()).get('/api/admin/content-rules').expect(401);

    const platform = await loginAs(app, f.users.platform.email);
    const rules = [
      ...POPSCI_DEFAULT_RULES,
      {
        id: 'custom',
        category: 'forbid',
        label: '合成规则',
        reason: '合成原因',
        terms: ['神奇'],
        negatable: false,
      },
    ];
    const saved = await platform
      .put('/api/admin/content-rules')
      .send({ baseVersion: 1, rules })
      .expect(200);
    expect(saved.body.version).toBe(2);
    expect(saved.body.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    // 用旧版本号再存：别人已经存过 → 409
    await platform.put('/api/admin/content-rules').send({ baseVersion: 1, rules }).expect(409);
    // 不合规的规则 400
    await platform
      .put('/api/admin/content-rules')
      .send({ baseVersion: 2, rules: [{ ...rules[0], id: 'builtin_x' }] })
      .expect(400);

    const id = await insertPopsci(a1, '一个神奇的方法。');
    const res = await approve(m, id);
    expect(res.body.reasons).toEqual(['content_check_failed']);
    expect((await detail(m, id)).contentCheck).toMatchObject({
      rulesVersion: 2,
      hits: [expect.objectContaining({ ruleId: 'custom' })],
    });
    // 操作记录
    const audit = await owner
      .selectFrom('admin_audit_log')
      .select(['object_type', 'action', 'actor_id'])
      .where('object_type', '=', 'content_rules')
      .execute();
    expect(audit).toEqual([
      { object_type: 'content_rules', action: 'updated', actor_id: f.users.platform.id },
    ]);
  });

  it('数据库层：非平台调用保存函数被拒绝；规则只能追加', async () => {
    const db = app.get<Db>(DB);
    await expect(
      withTenant(
        db,
        {
          userId: f.users.operatorAdminA.id,
          role: 'operator_admin',
          operatorId: f.operatorA,
          orgId: null,
        },
        (trx) =>
          sql`select admin_save_content_rules(1, ${JSON.stringify(POPSCI_DEFAULT_RULES)}::jsonb)`.execute(
            trx,
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 平台身份也不能直接改表
    await expect(
      withTenant(
        db,
        { userId: f.users.platform.id, role: 'platform_admin', operatorId: null, orgId: null },
        (trx) => sql`update content_rules set rules = '[]'::jsonb where version = 1`.execute(trx),
      ),
    ).rejects.toThrow();
  });

  it('数据库层：别人的产物不能写检查结果；核对人只能是本人；新建的结果一律未核对；读不到别人的结果', async () => {
    const db = app.get<Db>(DB);
    const mine = await insertPopsci(a1, '高血压人群少吃盐。');
    const theirs = await insertPopsci(b1, '高血压人群少吃盐。');
    const ctxA = {
      userId: f.users.managerA1.id,
      role: 'manager' as const,
      operatorId: f.operatorA,
      orgId: f.orgA,
    };
    const row = (artifactId: string, scope: Scope) => ({
      artifact_id: artifactId,
      operator_id: scope.operatorId,
      org_id: scope.orgId,
      manager_id: scope.managerId,
      rules_version: 1,
      hits: '[]',
    });
    for (const values of [row(theirs, b1), row(theirs, a1)]) {
      await expect(
        withTenant(db, ctxA, (trx) =>
          trx.insertInto('content_compliance_results').values(values).execute(),
        ),
      ).rejects.toThrow();
    }
    // 自己的产物：带着“已核对”插入也会被清空
    await withTenant(db, ctxA, (trx) =>
      trx
        .insertInto('content_compliance_results')
        .values({ ...row(mine, a1), acked_by: f.users.managerA1.id, acked_at: new Date() })
        .execute(),
    );
    const inserted = await owner
      .selectFrom('content_compliance_results')
      .select(['acked_by', 'acked_at'])
      .where('artifact_id', '=', mine)
      .executeTakeFirstOrThrow();
    expect(inserted).toEqual({ acked_by: null, acked_at: null });
    // 核对人写成别人被拒绝
    await expect(
      withTenant(db, ctxA, (trx) =>
        trx
          .updateTable('content_compliance_results')
          .set({ acked_by: f.users.managerA2.id, acked_at: new Date() })
          .where('artifact_id', '=', mine)
          .execute(),
      ),
    ).rejects.toThrow();
    // B 的结果对 A 和后台账号都不可见
    const b = await loginAs(app, f.users.managerB1.email);
    await detail(b, theirs);
    for (const ctx of [
      ctxA,
      {
        userId: f.users.operatorAdminB.id,
        role: 'operator_admin' as const,
        operatorId: f.operatorB,
        orgId: null,
      },
      {
        userId: f.users.platform.id,
        role: 'platform_admin' as const,
        operatorId: null,
        orgId: null,
      },
    ]) {
      const rows = await withTenant(db, ctx, (trx) =>
        trx.selectFrom('content_compliance_results').select('artifact_id').execute(),
      );
      expect(rows.map((r) => r.artifact_id)).not.toContain(theirs);
    }
  });

  it('客户转出后任务只读：核对和确认返回 409 read_only', async () => {
    const m = await loginAs(app, f.users.managerA1.email);
    const id = await insertPopsci(a1, '高血压人群少吃盐。');
    const { artifact } = await detail(m, id);
    await owner
      .updateTable('tasks')
      .set({ detached_reason: 'client_deleted', archived_at: new Date() })
      .where('id', '=', artifact.taskId)
      .execute();
    const ackRes = await m
      .post(`/api/artifacts/${id}/compliance-ack`)
      .send({ contentHash: artifact.contentHash });
    expect(ackRes.status).toBe(409);
    expect(ackRes.body.reasons).toEqual(['read_only']);
  });

  it('数据库层：缺字段、重复 id、词语不是字符串的规则被保存函数拒绝', async () => {
    const db = app.get<Db>(DB);
    const g = POPSCI_DEFAULT_RULES[0]!;
    const noId: Record<string, unknown> = { ...g };
    delete noId.id;
    for (const rules of [[noId], [g, g], [{ ...g, terms: [1] }], [{ ...g, label: '' }]]) {
      await expect(
        withTenant(
          db,
          { userId: f.users.platform.id, role: 'platform_admin', operatorId: null, orgId: null },
          (trx) =>
            sql`select admin_save_content_rules(1, ${JSON.stringify(rules)}::jsonb)`.execute(trx),
        ),
      ).rejects.toMatchObject({ code: '22023' });
    }
  });
});
