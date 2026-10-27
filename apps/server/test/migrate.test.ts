import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { TEST_APP_PASSWORD, TEST_OWNER_URL } from './env.js';
import { ownerDb } from './fixtures.js';

describe('迁移和平台管理员初始化', () => {
  const owner = ownerDb();
  afterAll(() => owner.destroy());

  it('重复执行迁移是安全的', async () => {
    const result = await migrate({ ownerUrl: TEST_OWNER_URL, appPassword: TEST_APP_PASSWORD });
    expect(result).toMatchObject({ applied: [], platformAdmin: 'skipped' });
  });

  it('没有平台管理员时创建一个，之后不再改动', async () => {
    await sql`truncate llm_usage, monitoring_readings, report_indicators, health_reports, sessions, clients, users, organizations, operators cascade`.execute(
      owner,
    );
    const admin = { email: 'root@test.example', password: 'initial-password-1' };

    const first = await migrate({
      ownerUrl: TEST_OWNER_URL,
      appPassword: TEST_APP_PASSWORD,
      platformAdmin: admin,
    });
    expect(first.platformAdmin).toBe('created');
    const before = await owner.selectFrom('users').select(['id', 'password_hash']).execute();
    expect(before).toHaveLength(1);
    expect(before[0]?.password_hash).toMatch(/^\$argon2id\$/);

    const second = await migrate({
      ownerUrl: TEST_OWNER_URL,
      appPassword: TEST_APP_PASSWORD,
      platformAdmin: { ...admin, password: 'another-password-2' },
    });
    expect(second.platformAdmin).toBe('exists');
    const after = await owner.selectFrom('users').select(['id', 'password_hash']).execute();
    expect(after).toEqual(before);
  });

  it('数据库里保存的是应用角色密码的 SCRAM 校验值，不是明文', async () => {
    const { rows } = await sql<{ rolpassword: string }>`
      select rolpassword from pg_authid where rolname = 'hb_app'
    `.execute(owner);
    expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
  });

  it('应用角色不是表的所有者，也不能绕过行级安全', async () => {
    const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'hb_app'
    `.execute(owner);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await sql<{ n: number }>`
      select count(*)::int as n from pg_tables where tableowner = 'hb_app'
    `.execute(owner);
    expect(owned.rows[0]?.n).toBe(0);
  });
});
