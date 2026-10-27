import { sql } from 'kysely';
import type { Db } from './database.js';

/**
 * M5 方案和随访用到的数据库函数（规格 6.1）。原始 SQL 只放在 db 目录里。
 */

/**
 * 清理到期的随访素材原文（Q23）。只能在没有租户上下文的连接上调用（后台任务），
 * 带用户身份时数据库拒绝。只返回删了几份。
 */
export async function visitMaterialsPurgeDue(db: Db, limit: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select visit_materials_purge_due(${limit}) as n
  `.execute(db);
  return rows[0]?.n ?? 0;
}
