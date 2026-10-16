import { DISCLAIMER } from '@health-buddy/shared';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  withTenant,
  type Db,
  type TenantContext,
  type TenantTransaction,
} from '../src/db/database.js';
import type { Database } from '../src/db/types.js';
import { TEST_APP_URL } from './env.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { insertTask, type Scope } from './work-fixtures.js';

/**
 * 迁移 0010 的数据库层约束（M2 规格 2.7、3.2，验收标准 20）：
 * 以应用角色 hb_app 直接连接，绕过仓储层，检查分层来源、产物依据的报告和建议分层。
 */
describe('分层来源产物和产物依据报告的数据库层约束', () => {
  const owner = ownerDb();
  let app: Db;
  let f: Fixtures;
  let reportA1: string;
  let reportA1Other: string;

  const ctx = (id: string, operatorId: string, orgId: string): TenantContext => ({
    userId: id,
    role: 'manager',
    operatorId,
    orgId,
  });
  const managerA1 = () => ctx(f.users.managerA1.id, f.operatorA, f.orgA);
  const managerA2 = () => ctx(f.users.managerA2.id, f.operatorA, f.orgA);
  const asA1 = <T>(fn: (trx: TenantTransaction) => Promise<T>) => withTenant(app, managerA1(), fn);
  const scopeA1 = (): Scope => ({
    operatorId: f.operatorA,
    orgId: f.orgA,
    managerId: f.users.managerA1.id,
  });

  /** 以所有者身份建一份产物（虚构数据），按需改成已审核 */
  async function artifact(
    s: Scope,
    clientId: string,
    options: {
      kind?: 'report_interpretation' | 'recent_summary';
      approved?: boolean;
      suggestion?: boolean;
      reportId?: string | null;
    } = {},
  ) {
    const taskId = await insertTask(owner, s, clientId);
    const id = crypto.randomUUID();
    const kind = options.kind ?? 'report_interpretation';
    await owner
      .insertInto('artifacts')
      .values({
        id,
        operator_id: s.operatorId,
        org_id: s.orgId,
        manager_id: s.managerId,
        task_id: taskId,
        client_id: clientId,
        skill_id: kind === 'recent_summary' ? 'client-recent-summary' : 'report-interpretation',
        kind,
        lineage_id: id,
        version: 1,
        status: 'draft',
        content: JSON.stringify({ professional: '合成', clientFacing: `您好。\n\n${DISCLAIMER}` }),
        critical_flags: '[]',
        source_report_id: options.reportId ?? null,
        risk_tier_suggestion:
          options.suggestion === false
            ? null
            : JSON.stringify({ tier: 'high', reason: '合成依据' }),
      })
      .execute();
    if (options.approved !== false) {
      await owner
        .updateTable('artifacts')
        .set({ status: 'approved' })
        .where('id', '=', id)
        .execute();
    }
    return id;
  }

  const tier = (clientId: string, sourceArtifactId: string | null, source = 'artifact') => ({
    operator_id: f.operatorA,
    org_id: f.orgA,
    manager_id: f.users.managerA1.id,
    client_id: clientId,
    tier: 'high' as const,
    reason: '合成理由',
    source: source as 'manual' | 'artifact',
    source_artifact_id: sourceArtifactId,
    set_by: f.users.managerA1.id,
  });

  beforeAll(() => {
    app = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }),
      }),
    });
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    const reports = await owner.selectFrom('health_reports').select(['id', 'client_id']).execute();
    reportA1 = reports.find((r) => r.client_id === f.clients.a1[0])!.id as string;
    reportA1Other = (
      await owner
        .insertInto('health_reports')
        .values({
          client_id: f.clients.a1[1],
          report_date: '2026-02-01',
          title: '合成报告',
          source: 'synthetic',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });

  it('来源产物必须是本人已审核、带建议分层的 /体检解读，且属于同一位客户', async () => {
    const ok = await artifact(scopeA1(), f.clients.a1[0], { reportId: reportA1 });
    await asA1((trx) =>
      trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], ok)).execute(),
    );

    const draft = await artifact(scopeA1(), f.clients.a1[0], { approved: false });
    const summary = await artifact(scopeA1(), f.clients.a1[0], {
      kind: 'recent_summary',
      suggestion: false,
    });
    const noSuggestion = await artifact(scopeA1(), f.clients.a1[0], { suggestion: false });
    const otherClient = await artifact(scopeA1(), f.clients.a1[1]);
    for (const source of [draft, summary, noSuggestion, otherClient]) {
      await expect(
        asA1((trx) =>
          trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], source)).execute(),
        ),
      ).rejects.toThrow();
    }
    // 同协会别的健管师的产物：看不到，按不存在处理
    const a2Scope = { ...scopeA1(), managerId: f.users.managerA2.id };
    const a2Artifact = await artifact(a2Scope, f.clients.a2);
    await expect(
      asA1((trx) =>
        trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], a2Artifact)).execute(),
      ),
    ).rejects.toThrow();
    // 给 A2 的客户写、来源是 A2 的产物：行级安全拒绝（租户列取自客户行）
    await expect(
      asA1((trx) =>
        trx.insertInto('client_risk_tiers').values(tier(f.clients.a2, a2Artifact)).execute(),
      ),
    ).rejects.toThrow();
    // 来源和来源产物必须一致
    await expect(
      asA1((trx) =>
        trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], null)).execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) =>
        trx
          .insertInto('client_risk_tiers')
          .values(tier(f.clients.a1[0], ok, 'manual'))
          .execute(),
      ),
    ).rejects.toThrow();
    const rows = await owner.selectFrom('client_risk_tiers').select('source_artifact_id').execute();
    expect(rows).toEqual([{ source_artifact_id: ok }]);
  });

  it('分层历史的来源不能改，也不能删', async () => {
    const ok = await artifact(scopeA1(), f.clients.a1[0]);
    await asA1((trx) =>
      trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], ok)).execute(),
    );
    await expect(
      asA1((trx) =>
        trx.updateTable('client_risk_tiers').set({ source_artifact_id: null }).execute(),
      ),
    ).rejects.toThrow();
    await expect(asA1((trx) => trx.deleteFrom('client_risk_tiers').execute())).rejects.toThrow();
  });

  it('其他健管师在自己的上下文里看不到这条分层，也看不到来源产物', async () => {
    const ok = await artifact(scopeA1(), f.clients.a1[0]);
    await asA1((trx) =>
      trx.insertInto('client_risk_tiers').values(tier(f.clients.a1[0], ok)).execute(),
    );
    const seen = await withTenant(app, managerA2(), async (trx) => ({
      tiers: await trx.selectFrom('client_risk_tiers').select('id').execute(),
      artifacts: await trx.selectFrom('artifacts').select('id').where('id', '=', ok).execute(),
    }));
    expect(seen).toEqual({ tiers: [], artifacts: [] });
    const none = await app.selectFrom('client_risk_tiers').select('id').execute();
    expect(none).toEqual([]);
  });

  it('产物依据的报告必须属于产物的客户；依据的报告和建议分层生成后不能改', async () => {
    const taskId = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const values = (
      reportId: string,
      clientTaskId = taskId,
      clientId: string | null = f.clients.a1[0],
    ) => {
      const id = crypto.randomUUID();
      return {
        id,
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
        task_id: clientTaskId,
        client_id: clientId,
        skill_id: 'report-interpretation',
        kind: 'report_interpretation',
        lineage_id: id,
        version: 1,
        status: 'draft' as const,
        content: JSON.stringify({ professional: '合成', clientFacing: '' }),
        source_report_id: reportId,
      };
    };
    // 别的客户的报告：外键拒绝
    await expect(
      asA1((trx) => trx.insertInto('artifacts').values(values(reportA1Other)).execute()),
    ).rejects.toThrow();
    // 没有客户的任务：不能引用报告
    const bareTask = await insertTask(owner, scopeA1(), null);
    await expect(
      asA1((trx) =>
        trx
          .insertInto('artifacts')
          .values(values(reportA1, bareTask, null))
          .execute(),
      ),
    ).rejects.toThrow();
    // 近况小结不能带建议分层
    await expect(
      asA1((trx) =>
        trx
          .insertInto('artifacts')
          .values({
            ...values(reportA1),
            skill_id: 'client-recent-summary',
            kind: 'recent_summary',
            risk_tier_suggestion: JSON.stringify({ tier: 'low', reason: '合成' }),
          })
          .execute(),
      ),
    ).rejects.toThrow();

    const row = values(reportA1);
    await asA1((trx) => trx.insertInto('artifacts').values(row).execute());
    await expect(
      asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ source_report_id: null })
          .where('id', '=', row.id)
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      asA1((trx) =>
        trx
          .updateTable('artifacts')
          .set({ risk_tier_suggestion: JSON.stringify({ tier: 'low', reason: '合成' }) })
          .where('id', '=', row.id)
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('执行步骤的报告日期只能是 YYYY-MM-DD，只能改自己的步骤', async () => {
    const taskId = await insertTask(owner, scopeA1(), f.clients.a1[0]);
    const message = await owner
      .insertInto('task_messages')
      .values({
        task_id: taskId,
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
        role: 'assistant',
        mode: 'craft',
        status: 'streaming',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const step = await owner
      .insertInto('task_steps')
      .values({
        message_id: message.id,
        operator_id: f.operatorA,
        org_id: f.orgA,
        manager_id: f.users.managerA1.id,
        seq: 0,
        kind: 'read_report',
        label_key: 'steps.readReport',
        status: 'running',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await asA1((trx) =>
      trx
        .updateTable('task_steps')
        .set({ label_date: '2026-09-12' })
        .where('id', '=', step.id)
        .execute(),
    );
    await expect(
      asA1((trx) =>
        trx
          .updateTable('task_steps')
          .set({ label_date: '某客户' })
          .where('id', '=', step.id)
          .execute(),
      ),
    ).rejects.toThrow();
    const updated = await withTenant(app, managerA2(), (trx) =>
      trx
        .updateTable('task_steps')
        .set({ label_date: '2026-01-01' })
        .where('id', '=', step.id)
        .execute(),
    );
    expect(updated[0]?.numUpdatedRows).toBe(0n);
  });
});
