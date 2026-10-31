import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB } from '../db/db.provider.js';
import type { Db, TenantContext } from '../db/database.js';
import type { Role } from '../db/types.js';

export interface LoginCandidate {
  id: string;
  /** 待激活（M7）的账号还没有密码 */
  passwordHash: string | null;
  role: Role;
  operatorId: string | null;
  orgId: string | null;
  active: boolean;
}

export interface ResolvedSession extends TenantContext {
  sessionId: string;
}

/**
 * 登录和会话只能通过数据库里的 SECURITY DEFINER 函数访问：
 * 应用角色既读不到 sessions 表，也读不到 users.password_hash 列。
 */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findLoginCandidate(email: string): Promise<LoginCandidate | undefined> {
    const { rows } = await sql<{
      id: string;
      password_hash: string | null;
      role: Role;
      operator_id: string | null;
      org_id: string | null;
      active: boolean;
    }>`select * from auth_find_user(${email})`.execute(this.db);
    const row = rows[0];
    return row
      ? {
          id: row.id,
          passwordHash: row.password_hash,
          role: row.role,
          operatorId: row.operator_id,
          orgId: row.org_id,
          active: row.active,
        }
      : undefined;
  }

  async createSession(userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void> {
    await sql`select auth_create_session(${userId}, ${tokenHash}, ${expiresAt})`.execute(this.db);
  }

  async resolveSession(tokenHash: Buffer): Promise<ResolvedSession | undefined> {
    const { rows } = await sql<{
      session_id: string;
      user_id: string;
      role: Role;
      operator_id: string | null;
      org_id: string | null;
    }>`select * from auth_resolve_session(${tokenHash})`.execute(this.db);
    const row = rows[0];
    return row
      ? {
          sessionId: row.session_id,
          userId: row.user_id,
          role: row.role,
          operatorId: row.operator_id,
          orgId: row.org_id,
        }
      : undefined;
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    await sql`select auth_revoke_session(${tokenHash})`.execute(this.db);
  }
}
