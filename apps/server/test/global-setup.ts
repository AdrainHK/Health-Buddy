import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_APP_PASSWORD, TEST_OWNER_URL } from './env.js';

/** 每次测试运行前重建测试库并执行全部迁移。 */
export default async function setup(): Promise<void> {
  const target = new URL(TEST_OWNER_URL);
  const dbName = target.pathname.slice(1);
  if (!/^hb_test\w*$/.test(dbName)) {
    throw new Error('测试库名必须以 hb_test 开头，防止误删其他数据库');
  }
  const admin = new URL(TEST_OWNER_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists ${dbName} with (force)`);
    await client.query(`create database ${dbName}`);
  } finally {
    await client.end();
  }
  await migrate({ ownerUrl: TEST_OWNER_URL, appPassword: TEST_APP_PASSWORD });
}
