import { DEFAULT_CRITICAL_RULES, DEFAULT_TWIN_STATUS_RULES } from '@health-buddy/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { hashPassword } from '../src/auth/password.js';
import { TEST_OWNER_URL } from './env.js';

export const PASSWORD = 'correct horse battery staple';

export interface Fixtures {
  operatorA: string;
  operatorB: string;
  orgA: string;
  /** 协会A下的第二个机构，用来测同一协会内机构之间的隔离 */
  orgA2: string;
  orgB: string;
  users: {
    platform: Account;
    operatorAdminA: Account;
    operatorAdminB: Account;
    orgAdminA: Account;
    orgAdminA2: Account;
    managerA1: Account;
    managerA2: Account;
    managerB1: Account;
    managerA3: Account;
    disabledManagerA: Account;
    suspendedOperatorManager: Account;
  };
  clients: {
    /** 健管师 A1 的两位客户 */
    a1: [string, string];
    a2: string;
    /** 机构 A2 的健管师 A3 的客户 */
    a3: string;
    b1: string;
  };
}

export interface Account {
  id: string;
  email: string;
}

type Owner = Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function ownerDb(): Owner {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: TEST_OWNER_URL, max: 2 }),
    }),
  });
}

/**
 * 两个协会的最小测试数据。用所有者身份写入，不受行级安全约束。
 * 全部是虚构数据。
 */
export async function seedFixtures(db: Owner): Promise<Fixtures> {
  await sql`truncate twin_rules_reset_marker, follow_up_events, follow_up_items, twin_forecasts, twin_status_history, twin_status_rule_events, twin_status_rules, expert_feedback, expert_calls, expert_consultations, expert_availability_events, expert_availability, storage_purge_queue, client_risk_tiers, client_health_history, artifact_events, artifacts, task_plans, task_steps, task_messages, tasks, critical_threshold_events, critical_thresholds, llm_usage, monitoring_readings, report_indicators, health_reports, sessions, clients, users, organizations, operators cascade`.execute(
    db,
  );
  // 阈值由迁移写入（全平台一套），清空后补回来
  for (const r of DEFAULT_CRITICAL_RULES) {
    await db
      .insertInto('critical_thresholds')
      .values({ metric: r.metric, comparator: r.comparator, value: r.value, level: r.level })
      .execute();
  }
  // 孪生状态规则同样由迁移写入（全平台一套），清空后补回来，版本号回到 1
  for (const r of DEFAULT_TWIN_STATUS_RULES) {
    await db
      .insertInto('twin_status_rules')
      .values({
        domain: r.domain,
        metric: r.metric,
        source: r.source,
        method: r.method,
        comparator: r.comparator,
        value: r.value,
        unit: r.unit,
        window_days: r.windowDays,
        level: r.level,
      })
      .execute();
  }
  await sql`truncate twin_status_rule_events`.execute(db);
  await sql`update twin_rules_version set version = 1, bumped_xact = null`.execute(db);
  const passwordHash = await hashPassword(PASSWORD);

  const op = async (name: string, slug: string, status = 'active') =>
    (
      await db
        .insertInto('operators')
        .values({ name, slug, status })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
  const org = async (operatorId: string, name: string) =>
    (
      await db
        .insertInto('organizations')
        .values({ operator_id: operatorId, name })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;
  const user = async (
    email: string,
    role: string,
    operatorId: string | null,
    orgId: string | null,
    status = 'active',
  ): Promise<Account> => {
    const row = await db
      .insertInto('users')
      .values({
        email,
        password_hash: passwordHash,
        display_name: `测试 ${email}`,
        role,
        operator_id: operatorId,
        org_id: orgId,
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id as string, email };
  };
  const client = async (manager: Account, operatorId: string, orgId: string, name: string) =>
    (
      await db
        .insertInto('clients')
        .values({
          operator_id: operatorId,
          org_id: orgId,
          manager_id: manager.id,
          display_name: name,
          gender: 'female',
          birth_year: 1970,
          is_synthetic: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id as string;

  const operatorA = await op('测试协会A', 'assoc-a');
  const operatorB = await op('测试协会B', 'assoc-b');
  const operatorC = await op('已停用协会C', 'assoc-c', 'suspended');
  const orgA = await org(operatorA, '测试机构A');
  const orgA2 = await org(operatorA, '测试机构A2');
  const orgB = await org(operatorB, '测试机构B');
  const orgC = await org(operatorC, '测试机构C');

  const users = {
    platform: await user('platform@test.example', 'platform_admin', null, null),
    operatorAdminA: await user('op-a@test.example', 'operator_admin', operatorA, null),
    operatorAdminB: await user('op-b@test.example', 'operator_admin', operatorB, null),
    orgAdminA: await user('org-a@test.example', 'org_admin', operatorA, orgA),
    orgAdminA2: await user('org-a2@test.example', 'org_admin', operatorA, orgA2),
    managerA1: await user('manager-a1@test.example', 'manager', operatorA, orgA),
    managerA2: await user('manager-a2@test.example', 'manager', operatorA, orgA),
    managerB1: await user('manager-b1@test.example', 'manager', operatorB, orgB),
    managerA3: await user('manager-a3@test.example', 'manager', operatorA, orgA2),
    disabledManagerA: await user('disabled@test.example', 'manager', operatorA, orgA, 'disabled'),
    suspendedOperatorManager: await user('manager-c@test.example', 'manager', operatorC, orgC),
  };

  const clients = {
    a1: [
      await client(users.managerA1, operatorA, orgA, '测试客户 A1-1'),
      await client(users.managerA1, operatorA, orgA, '测试客户 A1-2'),
    ] as [string, string],
    a2: await client(users.managerA2, operatorA, orgA, '测试客户 A2-1'),
    a3: await client(users.managerA3, operatorA, orgA2, '测试客户 A3-1'),
    b1: await client(users.managerB1, operatorB, orgB, '测试客户 B1-1'),
  };

  // 每位“A1 第一位客户”和“B1 客户”各一份报告、一项指标和一条监测数据
  for (const clientId of [clients.a1[0], clients.b1]) {
    const report = await db
      .insertInto('health_reports')
      .values({
        client_id: clientId,
        report_date: '2026-01-01',
        title: '测试报告',
        source: 'synthetic',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('report_indicators')
      .values({
        report_id: report.id,
        client_id: clientId,
        code: 'fpg',
        value: 5.5,
        unit: 'mmol/L',
      })
      .execute();
    await db
      .insertInto('monitoring_readings')
      .values({
        client_id: clientId,
        metric: 'sbp',
        value: 120,
        unit: 'mmHg',
        measured_at: new Date(),
        source: 'synthetic',
      })
      .execute();
  }

  return { operatorA, operatorB, orgA, orgA2, orgB, users, clients };
}
