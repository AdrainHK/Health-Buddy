import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database, Role } from './types.js';

export type Db = Kysely<Database>;
export type TenantTransaction = Transaction<Database>;

/** 当前请求的租户上下文，来自已验证的会话。 */
export interface TenantContext {
  userId: string;
  role: Role;
  operatorId: string | null;
  orgId: string | null;
}

export function createDb(connectionString: string, maxConnections = 10): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: maxConnections }),
    }),
  });
}

/**
 * 在一个事务里设置租户上下文并执行 fn。
 *
 * set_config 的第三个参数为 true，表示只在本事务内有效：事务结束后连接回到连接池时
 * 上下文自动清空，不会串到下一个请求。所有业务查询都必须经过这里。
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', ${ctx.userId}, true),
        set_config('app.role', ${ctx.role}, true),
        set_config('app.operator_id', ${ctx.operatorId ?? ''}, true),
        set_config('app.org_id', ${ctx.orgId ?? ''}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** 健康检查用：确认数据库可连接。 */
export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}
