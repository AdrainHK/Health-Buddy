import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { generateDemoData } from './generate.js';
import { assertSchemaReady, writeDemoData } from './write.js';

const env = z
  .object({
    /** 数据库所有者连接串（和迁移用的同一个） */
    DATABASE_URL: z.url(),
    /** 所有演示账号共用的密码，只放环境变量，不写进代码 */
    SEED_PASSWORD: z.string().min(12, 'SEED_PASSWORD 至少 12 位'),
    /**
     * 必须显式设为 yes 才运行。演示账号共用一个已知密码，等于一组可登录的账号，
     * 只能出现在开发库和预览环境，绝不能误跑到正式库上。
     */
    SEED_ALLOW: z.literal('yes', { error: 'SEED_ALLOW 必须设为 yes（只在开发库和预览环境设置）' }),
  })
  .safeParse(process.env);

if (!env.success) {
  // 只报变量名和原因，不打印值
  console.error(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: env.data.DATABASE_URL, max: 1 }),
  }),
});
try {
  await assertSchemaReady(db);
  const summary = await writeDemoData(db, generateDemoData(), env.data.SEED_PASSWORD);
  console.log(
    `演示数据已生成：${summary.operators} 个协会、${summary.managers} 名健管师、${summary.clients} 位客户、` +
      `${summary.reports} 份报告（${summary.indicators} 项指标）、${summary.readings} 条监测数据`,
  );
  console.log('演示账号（密码为 SEED_PASSWORD）：');
  for (const a of summary.accounts) console.log(`  ${a.role.padEnd(15)} ${a.email}`);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? ` (${String(err.code)})` : '';
  console.error(`生成失败：${err instanceof Error ? err.message : 'unknown'}${code}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
