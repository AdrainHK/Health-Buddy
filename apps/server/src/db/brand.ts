import { sql } from 'kysely';
import type { Db, TenantTransaction } from './database.js';

/** M7 协会品牌的数据库函数（迁移 0034）。函数里校验调用者是本协会在用的运营商管理员、写审计 */

export async function adminUpdateBrand(
  trx: TenantTransaction,
  v: { displayName: string | null; primaryColor: string | null; loginGreeting: string | null },
): Promise<void> {
  await sql`select admin_update_brand(${v.displayName}, ${v.primaryColor}, ${v.loginGreeting})`.execute(
    trx,
  );
}

/** 换 Logo，返回旧的对象 key */
export async function adminSetBrandLogo(
  trx: TenantTransaction,
  key: string,
  type: string,
): Promise<string | null> {
  const { rows } = await sql<{ old: string | null }>`
    select admin_set_brand_logo(${key}, ${type}) as old
  `.execute(trx);
  return rows[0]?.old ?? null;
}

export interface PublicBrandRow {
  name: string;
  brand_color: string | null;
  login_greeting: string | null;
  logo_object_key: string | null;
  logo_content_type: string | null;
  logo_updated_at: Date | null;
}

/** 登录页品牌（未登录调用）：协会不存在或已停用返回 undefined */
export async function publicBrand(db: Db, slug: string): Promise<PublicBrandRow | undefined> {
  const { rows } = await sql<PublicBrandRow>`select * from public_brand(${slug})`.execute(db);
  return rows[0];
}
