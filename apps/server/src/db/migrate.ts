import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/password.js';
import { APP_DB_ROLE } from '../config.js';
import { MIGRATIONS } from './migrations/index.js';

const provider: MigrationProvider = {
  getMigrations: () =>
    Promise.resolve(Object.fromEntries(MIGRATIONS.map((m) => [m.name, { up: m.up }]))),
};

function ownerDb(ownerUrl: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: ownerUrl, max: 1 }) }),
  });
}

/**
 * 创建或更新应用角色 hb_app。
 * 它不是表的所有者，也没有 BYPASSRLS，所以它发出的每条查询都受行级安全约束。
 */
export async function ensureAppRole(db: Kysely<unknown>, password: string): Promise<void> {
  // 只把 SCRAM 校验值发给数据库，明文密码不会出现在 SQL 里，即使数据库开启了语句日志也不会泄露。
  const literal = new pg.Client().escapeLiteral(scramVerifier(password));
  const { rows } = await sql<{ exists: boolean }>`
    select exists (select 1 from pg_roles where rolname = ${APP_DB_ROLE}) as exists
  `.execute(db);
  const verb = rows[0]?.exists ? 'alter' : 'create';
  await sql
    .raw(
      `${verb} role ${APP_DB_ROLE} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${literal}`,
    )
    .execute(db);
}

/** 按 RFC 5802 / PostgreSQL 的格式计算 SCRAM-SHA-256 校验值。 */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface PlatformAdminSeed {
  email: string;
  password: string;
}

/** 还没有平台管理员时创建一个；已有时什么都不做，也不会改已有账号的密码。 */
export async function bootstrapPlatformAdmin(
  db: Kysely<unknown>,
  admin: PlatformAdminSeed,
): Promise<'created' | 'exists'> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from users where role = 'platform_admin'
  `.execute(db);
  if ((rows[0]?.n ?? 0) > 0) return 'exists';
  const passwordHash = await hashPassword(admin.password);
  await sql`
    insert into users (email, password_hash, display_name, role)
    values (${admin.email}, ${passwordHash}, 'Platform Admin', 'platform_admin')
  `.execute(db);
  return 'created';
}

export interface MigrateOptions {
  ownerUrl: string;
  appPassword: string;
  platformAdmin?: PlatformAdminSeed | undefined;
}

export interface MigrateResult {
  applied: string[];
  platformAdmin: 'created' | 'exists' | 'skipped';
}

/** 部署时运行：确保应用角色存在、执行未执行的迁移、初始化平台管理员。 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const db = ownerDb(options.ownerUrl);
  try {
    await ensureAppRole(db, options.appPassword);
    const migrator = new Migrator({ db, provider });
    const { error, results } = await migrator.migrateToLatest();
    if (error) {
      const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
      throw new Error(`迁移 ${failed} 执行失败`, { cause: error });
    }
    const applied = (results ?? [])
      .filter((r) => r.status === 'Success')
      .map((r) => r.migrationName);
    const platformAdmin = options.platformAdmin
      ? await bootstrapPlatformAdmin(db, options.platformAdmin)
      : 'skipped';
    return { applied, platformAdmin };
  } finally {
    await db.destroy();
  }
}
