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

export interface TenantOptions {
  /**
   * M5 方案库预览开关（hb.plan_library_preview）：打开时行级安全放行“待审定”的库条目。
   * 只有仓储层在配置 PLAN_LIBRARY_PREVIEW=true 时传 true，正式环境永远不开。
   */
  planLibraryPreview?: boolean;
}

/**
 * 在一个事务里设置租户上下文并执行 fn。
 *
 * set_config 的第三个参数为 true，表示只在本事务内有效：事务结束后连接回到连接池时
 * 上下文自动清空，不会串到下一个请求。所有业务查询都必须经过这里。
 *
 * 隔离级别用 PostgreSQL 默认的 READ COMMITTED：产物的并发控制（先加行锁、再查是否最新版）
 * 依赖每条语句重新取快照。改成更高的隔离级别前，要先改那里的处理。
 */
export async function withTenant<T>(
  db: Db,
  ctx: TenantContext,
  fn: (trx: TenantTransaction) => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`
      select
        set_config('app.user_id', ${ctx.userId}, true),
        set_config('app.role', ${ctx.role}, true),
        set_config('app.operator_id', ${ctx.operatorId ?? ''}, true),
        set_config('app.org_id', ${ctx.orgId ?? ''}, true),
        set_config('hb.plan_library_preview', ${options.planLibraryPreview ? 'on' : ''}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** 健康检查用：确认数据库可连接。 */
export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}
