import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';

const config = loadConfig();
try {
  const result = await migrate({
    ownerUrl: config.ownerDatabaseUrl,
    appPassword: config.appDatabasePassword,
    platformAdmin: config.platformAdmin,
  });
  console.log(
    `迁移完成：新执行 ${result.applied.length} 个${result.applied.length ? `（${result.applied.join('、')}）` : ''}；平台管理员：${result.platformAdmin}`,
  );
} catch (err) {
  // 只打印错误类型和数据库错误码，不打印可能带数据的错误详情。
  const cause = err instanceof Error ? err.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  console.error(
    `迁移失败：${err instanceof Error ? err.message : 'unknown'}${code ? `（${code}）` : ''}`,
  );
  process.exitCode = 1;
}
