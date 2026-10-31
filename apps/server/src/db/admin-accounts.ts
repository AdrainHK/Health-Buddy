import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';
import type { Db } from './database.js';
import type { Role } from './types.js';

/**
 * M7 账号开通的数据库函数（迁移 0032）。函数开头校验调用者角色、写审计、停用时撤销会话；
 * 这里只负责传参。返回 false / null 表示对象不存在或不可操作。
 */

export async function adminCreateOperator(
  trx: TenantTransaction,
  v: {
    name: string;
    slug: string;
    region: string[];
    seatLimit: number;
    contractStart: string | null;
    contractEnd: string | null;
  },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select admin_create_operator(${v.name}, ${v.slug}, ${v.region}::text[], ${v.seatLimit},
      ${v.contractStart}::date, ${v.contractEnd}::date) as id
  `.execute(trx);
  return rows[0]!.id;
}

export async function adminUpdateOperator(
  trx: TenantTransaction,
  id: string,
  v: {
    name: string;
    region: string[];
    seatLimit: number;
    contractStart: string | null;
    contractEnd: string | null;
  },
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_update_operator(${id}::uuid, ${v.name}, ${v.region}::text[], ${v.seatLimit},
      ${v.contractStart}::date, ${v.contractEnd}::date) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

export async function adminSetOperatorStatus(
  trx: TenantTransaction,
  id: string,
  suspend: boolean,
  reason: string | null,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_set_operator_status(${id}::uuid, ${suspend}, ${reason}) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

export async function adminInviteUser(
  trx: TenantTransaction,
  v: {
    role: 'operator_admin';
    operatorId: string;
    orgId: string | null;
    email: string;
    displayName: string;
    tokenHash: Buffer;
    expiresAt: Date;
  },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    select admin_invite_user(${v.role}::user_role, ${v.operatorId}::uuid, ${v.orgId}::uuid,
      ${v.email}, ${v.displayName}, ${v.tokenHash}, ${v.expiresAt}) as id
  `.execute(trx);
  return rows[0]!.id;
}

export async function adminReinvite(
  trx: TenantTransaction,
  userId: string,
  tokenHash: Buffer,
  expiresAt: Date,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_reinvite(${userId}::uuid, ${tokenHash}, ${expiresAt}) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

export async function adminSetUserStatus(
  trx: TenantTransaction,
  userId: string,
  disable: boolean,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select admin_set_user_status(${userId}::uuid, ${disable}) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}

/** 未登录调用：邀请有效时设置密码并激活，返回账号角色；无效返回 null */
export async function authAcceptInvite(
  db: Db,
  tokenHash: Buffer,
  passwordHash: string,
): Promise<Role | null> {
  const { rows } = await sql<{ role: Role | null }>`
    select auth_accept_invite(${tokenHash}, ${passwordHash}) as role
  `.execute(db);
  return rows[0]?.role ?? null;
}

/** 已占用的席位：协会里待激活和已激活的健管师（Q7） */
export async function seatsUsed(trx: TenantTransaction): Promise<Map<string, number>> {
  const { rows } = await sql<{ operator_id: string; n: string }>`
    select operator_id, count(*) as n from users
    where role = 'manager' and status in ('pending', 'active') and operator_id is not null
    group by operator_id
  `.execute(trx);
  return new Map(rows.map((r) => [r.operator_id, Number(r.n)]));
}
