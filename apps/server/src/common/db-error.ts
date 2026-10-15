/**
 * 把数据库错误压缩成一个错误码，供日志使用：
 * PostgreSQL 错误码（如 28P01 密码错误、42P01 表不存在）或 Node 网络错误码（如 ECONNREFUSED、ENOTFOUND）。
 * 只取错误码，不取错误信息，避免把连接串、SQL 或数据带进日志。
 */
export function dbErrorCode(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return 'unknown';
}
