import { hash } from '@node-rs/argon2';
import { MONITORING_METRICS, REPORT_INDICATORS } from '@health-buddy/shared';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_OPERATOR_SLUGS,
  type DemoAccount,
  type DemoOperator,
} from './generate.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 以所有者身份写库，不需要完整的表类型
type OwnerDb = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trx = Transaction<any>;

const UNIT: Record<string, string> = Object.fromEntries(
  [...REPORT_INDICATORS, ...MONITORING_METRICS].map((d) => [d.code, d.unit]),
);

export interface SeedSummary {
  operators: number;
  managers: number;
  clients: number;
  reports: number;
  indicators: number;
  readings: number;
  accounts: { role: string; email: string }[];
}

/**
 * 写入演示数据。以数据库所有者身份执行，在一个事务里完成：
 * 先清理上一次生成的演示协会（只按演示 slug 定位），再全部重建，所以可以反复运行。
 * 演示协会以外的任何数据都不会被修改。
 */
export async function writeDemoData(
  db: OwnerDb,
  operators: DemoOperator[],
  password: string,
): Promise<SeedSummary> {
  // 和后端一致的 argon2id 参数
  const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const summary: SeedSummary = {
    operators: 0,
    managers: 0,
    clients: 0,
    reports: 0,
    indicators: 0,
    readings: 0,
    accounts: [],
  };

  await db.transaction().execute(async (trx) => {
    await removeDemoData(trx);

    for (const op of operators) {
      const operatorId = await insertId(trx, 'operators', {
        name: op.name,
        slug: op.slug,
        brand_color: op.brandColor,
      });
      summary.operators++;
      const orgId = await insertId(trx, 'organizations', {
        operator_id: operatorId,
        name: op.org.name,
      });

      const user = async (account: DemoAccount, role: string, org: string | null) => {
        summary.accounts.push({ role, email: account.email });
        return insertId(trx, 'users', {
          email: account.email,
          password_hash: passwordHash,
          display_name: account.displayName,
          role,
          operator_id: operatorId,
          org_id: org,
        });
      };
      await user(op.admin, 'operator_admin', null);
      await user(op.org.admin, 'org_admin', orgId);

      for (const manager of op.org.managers) {
        const managerId = await user(manager, 'manager', orgId);
        summary.managers++;

        for (const client of manager.clients) {
          const clientId = await insertId(trx, 'clients', {
            operator_id: operatorId,
            org_id: orgId,
            manager_id: managerId,
            display_name: client.displayName,
            gender: client.gender,
            birth_year: client.birthYear,
            is_synthetic: true,
          });
          summary.clients++;

          for (const report of client.reports) {
            const reportId = await insertId(trx, 'health_reports', {
              client_id: clientId,
              report_date: report.reportDate,
              title: report.title,
              source: 'synthetic',
            });
            summary.reports++;
            const rows = Object.entries(report.indicators).map(([code, value]) => ({
              report_id: reportId,
              client_id: clientId,
              code,
              value,
              unit: unitOf(code),
            }));
            if (rows.length) await trx.insertInto('report_indicators').values(rows).execute();
            summary.indicators += rows.length;
          }

          const readings = client.readings.map((r) => ({
            client_id: clientId,
            metric: r.metric,
            value: r.value,
            unit: unitOf(r.metric),
            measured_at: r.measuredAt,
            source: 'synthetic',
          }));
          if (readings.length)
            await trx.insertInto('monitoring_readings').values(readings).execute();
          summary.readings += readings.length;
        }
      }
    }
  });

  return summary;
}

/**
 * 删除演示协会及其下的全部数据。只按演示 slug 定位。
 * 删除前确认里面只有本脚本生成的数据：只要发现非合成客户或非演示域名的账号就中止，
 * 防止有人在演示协会里录入了真实客户，或真实协会碰巧用了同样的 slug。
 */
async function removeDemoData(trx: Trx): Promise<void> {
  const slugs = [...DEMO_OPERATOR_SLUGS];
  const ops = trx.selectFrom('operators').select('id').where('slug', 'in', slugs);
  const realClients = await trx
    .selectFrom('clients')
    .select('id')
    .where('operator_id', 'in', ops)
    .where('is_synthetic', '=', false)
    .limit(1)
    .execute();
  const otherUsers = await trx
    .selectFrom('users')
    .select('id')
    .where('operator_id', 'in', ops)
    .where('email', 'not like', `%@${DEMO_EMAIL_DOMAIN}`)
    .limit(1)
    .execute();
  if (realClients.length || otherUsers.length) {
    throw new Error('演示协会里有不是本脚本生成的客户或账号，已中止，没有删除任何数据');
  }
  const users = trx.selectFrom('users').select('id').where('operator_id', 'in', ops);
  // 客户删除会级联删掉报告、指标和监测数据；会话随用户级联删除
  await trx.deleteFrom('llm_usage').where('user_id', 'in', users).execute();
  await trx.deleteFrom('clients').where('operator_id', 'in', ops).execute();
  await trx.deleteFrom('users').where('operator_id', 'in', ops).execute();
  await trx.deleteFrom('organizations').where('operator_id', 'in', ops).execute();
  await trx.deleteFrom('operators').where('slug', 'in', slugs).execute();
}

async function insertId(trx: Trx, table: string, values: Record<string, unknown>): Promise<string> {
  const row = (await trx
    .insertInto(table)
    .values(values)
    .returning('id')
    .executeTakeFirstOrThrow()) as {
    id: string;
  };
  return row.id;
}

function unitOf(code: string): string {
  const unit = UNIT[code];
  if (!unit) throw new Error(`指标目录里没有 ${code}`);
  return unit;
}

/** 确认目标库已经执行过迁移，避免把数据写进空库或错误的库。 */
export async function assertSchemaReady(db: OwnerDb): Promise<void> {
  const { rows } = await sql<{ ok: boolean }>`
    select to_regclass('public.monitoring_readings') is not null as ok
  `.execute(db);
  if (!rows[0]?.ok) throw new Error('数据库还没有执行迁移，请先运行 pnpm db:migrate');
}

/** 演示协会是否已经存在。 */
export async function demoDataExists(db: OwnerDb): Promise<boolean> {
  const rows = await db
    .selectFrom('operators')
    .select('id')
    .where('slug', 'in', [...DEMO_OPERATOR_SLUGS])
    .limit(1)
    .execute();
  return rows.length > 0;
}
