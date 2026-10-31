import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_LOG_LIMIT,
  CONTRACT_EXPIRY_NOTICE_DAYS,
  type AccountSummary,
  type AuditLogEntry,
  type AuditLogQuery,
  type AccountImportRow,
  type CreateOperatorRequest,
  type OperatorAccount,
  type OperatorInviteRequest,
  type OperatorSummary,
  type OrganizationSummary,
  type UpdateOperatorRequest,
} from '@health-buddy/shared';
import { ApiException, badRequest, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import {
  adminClientCounts,
  adminCreateOperator,
  adminCreateOrganization,
  adminImportAccounts,
  adminInviteUser,
  adminReinvite,
  adminSetOperatorStatus,
  adminSetUserStatus,
  adminUpdateOperator,
  authAcceptInvite,
  seatsUsed,
  type ImportResult,
  type ImportRowInput,
} from '../db/admin-accounts.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type { Role } from '../db/types.js';

const DAY_MS = 86_400_000;

export const seatLimitReached = (details: { seatsLeft: number; needed: number }) =>
  new ApiException(HttpStatus.CONFLICT, 'seat_limit_reached', details);
export const hasClients = () => new ApiException(HttpStatus.CONFLICT, 'has_clients');

type OperatorRow = {
  id: string;
  name: string;
  slug: string;
  region: string[];
  status: 'active' | 'suspended';
  suspended_reason: string | null;
  seat_limit: number;
  contract_start: Date | null;
  contract_end: Date | null;
  created_at: Date;
};

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function toOperator(row: OperatorRow, used: number, now: Date): OperatorSummary {
  const end = isoDate(row.contract_end);
  const today = now.toISOString().slice(0, 10);
  const notice = new Date(now.getTime() + CONTRACT_EXPIRY_NOTICE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    region: row.region,
    status: row.status,
    suspendedReason: row.suspended_reason,
    seatLimit: row.seat_limit,
    seatsUsed: used,
    contractStart: isoDate(row.contract_start),
    contractEnd: end,
    expired: end !== null && end < today,
    expiringSoon: end !== null && end <= notice,
    createdAt: row.created_at.toISOString(),
  };
}

const ACCOUNT_COLUMNS = [
  'id',
  'display_name',
  'email',
  'role',
  'status',
  'org_id',
  'created_at',
  'last_login_at',
] as const;

function toAccount(row: {
  id: string;
  display_name: string;
  email: string;
  role: AccountSummary['role'];
  status: AccountSummary['status'];
  org_id: string | null;
  created_at: Date;
  last_login_at: Date | null;
}): AccountSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    orgId: row.org_id,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

/**
 * 协会和账号开通（M7 规格 2.1、2.4、2.7）。读走行级安全，写只调数据库函数
 * （函数里再校验角色、写审计、撤销会话）。别人的对象在这里查不到，返回 undefined → 404。
 */
@Injectable()
export class AdminAccountsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  listOperators(ctx: TenantContext): Promise<OperatorSummary[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('operators')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();
      const used = await seatsUsed(trx);
      const now = new Date();
      return rows.map((r) => toOperator(r as OperatorRow, used.get(r.id) ?? 0, now));
    });
  }

  getOperator(ctx: TenantContext, id: string): Promise<OperatorSummary | undefined> {
    return withTenant(this.db, ctx, (trx) => this.operatorIn(trx, id));
  }

  createOperator(ctx: TenantContext, v: CreateOperatorRequest): Promise<OperatorSummary> {
    return this.write(ctx, async (trx) => {
      const id = await adminCreateOperator(trx, v);
      return (await this.operatorIn(trx, id))!;
    });
  }

  updateOperator(
    ctx: TenantContext,
    id: string,
    v: UpdateOperatorRequest,
  ): Promise<OperatorSummary | undefined> {
    return this.write(ctx, async (trx) =>
      (await adminUpdateOperator(trx, id, v)) ? this.operatorIn(trx, id) : undefined,
    );
  }

  setOperatorStatus(
    ctx: TenantContext,
    id: string,
    suspend: boolean,
    reason: string | null,
  ): Promise<OperatorSummary | undefined> {
    return this.write(ctx, async (trx) =>
      (await adminSetOperatorStatus(trx, id, suspend, reason))
        ? this.operatorIn(trx, id)
        : undefined,
    );
  }

  /** 协会的账号列表；协会不存在（或看不到）返回 undefined */
  listAccounts(ctx: TenantContext, operatorId: string): Promise<AccountSummary[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await this.operatorIn(trx, operatorId))) return undefined;
      const rows = await trx
        .selectFrom('users')
        .select(ACCOUNT_COLUMNS)
        .where('operator_id', '=', operatorId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map(toAccount);
    });
  }

  inviteOperatorAdmin(
    ctx: TenantContext,
    operatorId: string,
    v: { displayName: string; email: string; tokenHash: Buffer; expiresAt: Date },
  ): Promise<AccountSummary | undefined> {
    return this.write(ctx, async (trx) => {
      if (!(await this.operatorIn(trx, operatorId))) return undefined;
      const id = await adminInviteUser(trx, {
        role: 'operator_admin',
        operatorId,
        orgId: null,
        email: v.email,
        displayName: v.displayName,
        tokenHash: v.tokenHash,
        expiresAt: v.expiresAt,
      });
      return this.accountIn(trx, id);
    });
  }

  reinvite(
    ctx: TenantContext,
    userId: string,
    tokenHash: Buffer,
    expiresAt: Date,
  ): Promise<AccountSummary | undefined> {
    return this.write(ctx, async (trx) =>
      (await adminReinvite(trx, userId, tokenHash, expiresAt))
        ? this.accountIn(trx, userId)
        : undefined,
    );
  }

  setAccountStatus(
    ctx: TenantContext,
    userId: string,
    disable: boolean,
  ): Promise<AccountSummary | undefined> {
    return this.write(ctx, async (trx) =>
      (await adminSetUserStatus(trx, userId, disable)) ? this.accountIn(trx, userId) : undefined,
    );
  }

  /* ---------- 第 2 步：运营商管理员在本协会（协会由会话决定） ---------- */

  /** 本协会的信息和席位（运营商管理员读得到自己协会这一行） */
  myOperator(ctx: TenantContext): Promise<OperatorSummary | undefined> {
    return withTenant(this.db, ctx, (trx) =>
      ctx.operatorId ? this.operatorIn(trx, ctx.operatorId) : Promise.resolve(undefined),
    );
  }

  listOrganizations(ctx: TenantContext): Promise<OrganizationSummary[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('organizations')
        .select(['id', 'name', 'created_at'])
        .where('operator_id', '=', ctx.operatorId!)
        .orderBy('created_at', 'asc')
        .execute();
      return this.withOrgCounts(trx, ctx, rows);
    });
  }

  createOrganization(ctx: TenantContext, name: string): Promise<OrganizationSummary> {
    return this.write(ctx, async (trx) => {
      const id = await adminCreateOrganization(trx, name);
      const rows = await trx
        .selectFrom('organizations')
        .select(['id', 'name', 'created_at'])
        .where('id', '=', id)
        .execute();
      return (await this.withOrgCounts(trx, ctx, rows))[0]!;
    });
  }

  /** 运营商管理员看本协会全部账号；机构管理员只看本机构的（行级安全之外再按会话限定） */
  listOperatorAccounts(ctx: TenantContext): Promise<OperatorAccount[]> {
    return withTenant(this.db, ctx, async (trx) => {
      let q = trx.selectFrom('users').select(ACCOUNT_COLUMNS);
      q =
        ctx.role === 'org_admin'
          ? q.where('org_id', '=', ctx.orgId!)
          : q.where('operator_id', '=', ctx.operatorId!);
      const rows = await q.orderBy('created_at', 'desc').execute();
      if (ctx.role !== 'operator_admin') {
        return rows.map((r) => ({ ...toAccount(r), clientCount: null }));
      }
      const counts = await adminClientCounts(trx);
      const byManager = new Map<string, number>();
      const byOrg = new Map<string, number>();
      for (const c of counts) {
        byManager.set(c.manager_id, (byManager.get(c.manager_id) ?? 0) + c.n);
        if (c.org_id) byOrg.set(c.org_id, (byOrg.get(c.org_id) ?? 0) + c.n);
      }
      return rows.map((r) => ({
        ...toAccount(r),
        clientCount:
          r.role === 'manager'
            ? (byManager.get(r.id) ?? 0)
            : r.role === 'org_admin' && r.org_id
              ? (byOrg.get(r.org_id) ?? 0)
              : 0,
      }));
    });
  }

  inviteInOperator(
    ctx: TenantContext,
    v: OperatorInviteRequest & { tokenHash: Buffer; expiresAt: Date },
  ): Promise<AccountSummary | undefined> {
    return this.write(ctx, async (trx) => {
      const id = await adminInviteUser(trx, {
        role: v.role,
        operatorId: ctx.operatorId!,
        orgId: v.orgId,
        email: v.email,
        displayName: v.displayName,
        tokenHash: v.tokenHash,
        expiresAt: v.expiresAt,
      });
      return this.accountIn(trx, id);
    });
  }

  /**
   * 批量开通。rows 里已带好每行的令牌哈希；formatErrors 是服务器先查出来的格式错误，
   * 有的话只让数据库校验其余行、不写入。成功返回每行的账号。
   */
  importAccounts(
    ctx: TenantContext,
    rows: (AccountImportRow & { tokenHash: Buffer })[],
    expiresAt: Date,
    commit: boolean,
  ): Promise<ImportResult & { accounts: Map<number, AccountSummary> }> {
    return this.write(ctx, async (trx) => {
      const input: ImportRowInput[] = rows.map((r) => ({
        row: r.row,
        role: r.role,
        name: r.displayName,
        email: r.email,
        org_name: r.orgName,
        token_hash: r.tokenHash.toString('hex'),
      }));
      const result = await adminImportAccounts(trx, input, expiresAt, commit);
      const accounts = new Map<number, AccountSummary>();
      for (const { row, id } of result.ids) {
        const account = await this.accountIn(trx, id);
        if (account) accounts.set(row, account);
      }
      return { ...result, accounts };
    });
  }

  /** 接受邀请，返回账号角色（激活前不在任何租户上下文里，只经函数） */
  async acceptInvite(tokenHash: Buffer, passwordHash: string): Promise<Role | null> {
    return authAcceptInvite(this.db, tokenHash, passwordHash);
  }

  auditLog(
    ctx: TenantContext,
    q: AuditLogQuery,
  ): Promise<{ entries: AuditLogEntry[]; truncated: boolean }> {
    return withTenant(this.db, ctx, async (trx) => {
      let query = trx
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('created_at', '>=', new Date(`${q.from}T00:00:00Z`))
        .where('created_at', '<', new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY_MS));
      if (q.operatorId) query = query.where('operator_id', '=', q.operatorId);
      if (q.objectType) query = query.where('object_type', '=', q.objectType);
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(AUDIT_LOG_LIMIT + 1)
        .execute();
      return {
        truncated: rows.length > AUDIT_LOG_LIMIT,
        entries: rows.slice(0, AUDIT_LOG_LIMIT).map((r) => ({
          id: String(r.id),
          operatorId: r.operator_id,
          actorId: r.actor_id,
          actorRole: r.actor_role,
          objectType: r.object_type,
          objectId: r.object_id,
          action: r.action as AuditLogEntry['action'],
          before: r.before,
          after: r.after,
          createdAt: r.created_at.toISOString(),
        })),
      };
    });
  }

  private async operatorIn(
    trx: TenantTransaction,
    id: string,
  ): Promise<OperatorSummary | undefined> {
    const row = await trx
      .selectFrom('operators')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    const used = await seatsUsed(trx);
    return toOperator(row as OperatorRow, used.get(id) ?? 0, new Date());
  }

  private async withOrgCounts(
    trx: TenantTransaction,
    ctx: TenantContext,
    rows: { id: string; name: string; created_at: Date }[],
  ): Promise<OrganizationSummary[]> {
    const managers = await trx
      .selectFrom('users')
      .select(['org_id', (eb) => eb.fn.countAll<string>().as('n')])
      .where('operator_id', '=', ctx.operatorId!)
      .where('role', '=', 'manager')
      .where('status', 'in', ['pending', 'active'])
      .groupBy('org_id')
      .execute();
    const clients = ctx.role === 'operator_admin' ? await adminClientCounts(trx) : [];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      managerCount: Number(managers.find((m) => m.org_id === r.id)?.n ?? 0),
      clientCount: clients.filter((c) => c.org_id === r.id).reduce((a, c) => a + c.n, 0),
      createdAt: r.created_at.toISOString(),
    }));
  }

  private async accountIn(trx: TenantTransaction, id: string): Promise<AccountSummary | undefined> {
    const row = await trx
      .selectFrom('users')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  /**
   * 简称、邮箱、机构名重复 409；席位不够 409 seat_limit_reached；有客户 409 has_clients；
   * 形状、长度不对（数据库 check）400；对象不存在（P0002）由调用方按 404 处理
   */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      const code = dbErrorCode(err);
      if (code === '23505') throw conflict();
      if (code === 'HB001') throw seatLimitReached({ seatsLeft: 0, needed: 1 });
      if (code === 'HB002') throw hasClients();
      if (code === '23514' || code === '22023' || code === '22001') throw badRequest();
      if (code === 'P0002') return undefined as T;
      throw err;
    }
  }
}
