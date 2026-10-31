import {
  Body,
  Header,
  Inject,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  INVITE_TTL_HOURS,
  OPERATOR_INVITE_ROLES,
  acceptInviteRequestSchema,
  accountImportRequestSchema,
  createOrganizationRequestSchema,
  operatorInviteRequestSchema,
  auditLogQuerySchema,
  createOperatorRequestSchema,
  inviteAccountRequestSchema,
  suspendOperatorRequestSchema,
  updateOperatorRequestSchema,
  type AcceptInviteResponse,
  type AccountImportResponse,
  type AccountImportRowError,
  type OperatorAccountListResponse,
  type OrganizationListResponse,
  type OrganizationResponse,
  type AccountListResponse,
  type AccountResponse,
  type AuditLogResponse,
  type InviteResponse,
  type OperatorListResponse,
  type OperatorResponse,
} from '@health-buddy/shared';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession, Public, type AuthedRequest } from '../auth/decorators.js';
import { LoginRateLimiter } from '../auth/login-rate-limiter.js';
import { hashPassword } from '../auth/password.js';
import { hashToken } from '../auth/session.service.js';
import {
  ApiException,
  badRequest,
  forbidden,
  notFound,
  tooManyRequests,
} from '../common/api-error.js';
import { AdminAccountsRepository, seatLimitReached } from './admin-accounts.repository.js';

const idSchema = z.uuid();
const HOUR_MS = 3_600_000;

/** 只有平台管理员（M7 第 1 步）；其他后台角色和健管师 403（按角色拒绝，不涉及具体资源） */
function requirePlatform(session: ResolvedSession): void {
  if (session.role !== 'platform_admin') throw forbidden();
}

/** 运营商管理员（本协会）；其他角色 403 */
function requireOperatorAdmin(session: ResolvedSession): void {
  if (session.role !== 'operator_admin' || !session.operatorId) throw forbidden();
}

/** 停用、恢复、重发邀请：平台和运营商管理员（能动哪些账号由数据库函数决定，别人的 404） */
function requireAccountAdmin(session: ResolvedSession): void {
  if (session.role !== 'platform_admin' && session.role !== 'operator_admin') throw forbidden();
}

const importEmailSchema = z.email().max(254);

/** 批量开通的格式检查（业务校验在数据库函数里） */
function rowFormatError(r: {
  displayName: string;
  email: string;
  role: string;
}): AccountImportRowError | null {
  if (!(OPERATOR_INVITE_ROLES as readonly string[]).includes(r.role)) return 'role_invalid';
  const name = r.displayName.trim();
  if (name.length < 1 || name.length > 40) return 'name_invalid';
  if (!importEmailSchema.safeParse(r.email.trim()).success) return 'email_invalid';
  return null;
}

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

function newInvite(): { token: string; tokenHash: Buffer; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * HOUR_MS),
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // 防止表格软件把 = + - @ 开头的内容当公式
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * 协会和账号开通（M7 规格 2.1、2.4、2.7、6.4）。
 * - /api/admin/operators[...]：开通、修改、停用、恢复协会，开通协会的运营商管理员——只有平台管理员；
 * - /api/admin/my-operator、/api/admin/organizations、POST /api/admin/accounts[/import]：
 *   运营商管理员在本协会开机构、开健管师和机构管理员（第 2 步）；GET /api/admin/accounts 机构管理员只读本机构；
 * - /api/admin/accounts/:id/{suspend,resume,reinvite}：停用、恢复账号、重发邀请（找回密码）——平台和
 *   运营商管理员，能动哪些账号由数据库函数限定；
 * - /api/admin/audit-log[/export]：平台看全部、运营商管理员看本协会（行级安全），其他 403；
 * - /api/auth/invite/accept：未登录，凭一次性令牌设置密码。失败统一 410，不区分原因。
 * 邀请链接只在开通、重发邀请的响应里出现一次；日志里不记邮箱、令牌、链接（红线 2、6）。
 */
/** 接受邀请的失败计数（和登录分开） */
export const INVITE_RATE_LIMITER = Symbol('INVITE_RATE_LIMITER');

@Controller()
export class AdminAccountsController {
  constructor(
    private readonly repo: AdminAccountsRepository,
    @Inject(INVITE_RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  @Get('admin/operators')
  async list(@CurrentSession() session: ResolvedSession): Promise<OperatorListResponse> {
    requirePlatform(session);
    return { operators: await this.repo.listOperators(session) };
  }

  @Post('admin/operators')
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<OperatorResponse> {
    requirePlatform(session);
    const parsed = createOperatorRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { operator: await this.repo.createOperator(session, parsed.data) };
  }

  @Get('admin/operators/:id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<OperatorResponse> {
    requirePlatform(session);
    const operator = await this.repo.getOperator(session, parseId(id));
    if (!operator) throw notFound();
    return { operator };
  }

  @Patch('admin/operators/:id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OperatorResponse> {
    requirePlatform(session);
    const parsed = updateOperatorRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const operator = await this.repo.updateOperator(session, parseId(id), parsed.data);
    if (!operator) throw notFound();
    return { operator };
  }

  @Post('admin/operators/:id/suspend')
  @HttpCode(200)
  async suspend(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OperatorResponse> {
    requirePlatform(session);
    const parsed = suspendOperatorRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const operator = await this.repo.setOperatorStatus(
      session,
      parseId(id),
      true,
      parsed.data.reason,
    );
    if (!operator) throw notFound();
    return { operator };
  }

  @Post('admin/operators/:id/resume')
  @HttpCode(200)
  async resume(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<OperatorResponse> {
    requirePlatform(session);
    const operator = await this.repo.setOperatorStatus(session, parseId(id), false, null);
    if (!operator) throw notFound();
    return { operator };
  }

  @Get('admin/operators/:id/accounts')
  async accounts(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<AccountListResponse> {
    requirePlatform(session);
    const accounts = await this.repo.listAccounts(session, parseId(id));
    if (!accounts) throw notFound();
    return { accounts };
  }

  @Post('admin/operators/:id/accounts')
  // 响应里有一次性邀请令牌，不让浏览器和代理缓存（租户审查 S7）
  @Header('Cache-Control', 'no-store')
  async invite(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<InviteResponse> {
    requirePlatform(session);
    const parsed = inviteAccountRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const invite = newInvite();
    const account = await this.repo.inviteOperatorAdmin(session, parseId(id), {
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      tokenHash: invite.tokenHash,
      expiresAt: invite.expiresAt,
    });
    if (!account) throw notFound();
    return {
      account,
      invitePath: `/#/invite/${invite.token}`,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  @Get('admin/my-operator')
  async myOperator(@CurrentSession() session: ResolvedSession): Promise<OperatorResponse> {
    requireOperatorAdmin(session);
    const operator = await this.repo.myOperator(session);
    if (!operator) throw notFound();
    return { operator };
  }

  @Get('admin/organizations')
  async organizations(
    @CurrentSession() session: ResolvedSession,
  ): Promise<OrganizationListResponse> {
    requireOperatorAdmin(session);
    return { organizations: await this.repo.listOrganizations(session) };
  }

  @Post('admin/organizations')
  async createOrganization(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<OrganizationResponse> {
    requireOperatorAdmin(session);
    const parsed = createOrganizationRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { organization: await this.repo.createOrganization(session, parsed.data.name) };
  }

  @Get('admin/accounts')
  async operatorAccounts(
    @CurrentSession() session: ResolvedSession,
  ): Promise<OperatorAccountListResponse> {
    if (session.role === 'org_admin') {
      if (!session.orgId) throw forbidden();
    } else {
      requireOperatorAdmin(session);
    }
    return { accounts: await this.repo.listOperatorAccounts(session) };
  }

  @Post('admin/accounts')
  @Header('Cache-Control', 'no-store')
  async inviteInOperator(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<InviteResponse> {
    requireOperatorAdmin(session);
    const parsed = operatorInviteRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const invite = newInvite();
    const account = await this.repo.inviteInOperator(session, {
      ...parsed.data,
      tokenHash: invite.tokenHash,
      expiresAt: invite.expiresAt,
    });
    if (!account) throw notFound();
    return {
      account,
      invitePath: `/#/invite/${invite.token}`,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * 批量开通（规格 2.4 第 2 条）：先查格式，再由数据库逐行查邮箱、机构、席位；
   * 任何一行有错 400（带每行原因），只有席位不够 409 seat_limit_reached，全对才写入。
   */
  @Post('admin/accounts/import')
  @Header('Cache-Control', 'no-store')
  async importAccounts(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<AccountImportResponse> {
    requireOperatorAdmin(session);
    const parsed = accountImportRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const rows = parsed.data.rows;
    if (new Set(rows.map((r) => r.row)).size !== rows.length) throw badRequest();
    // 套餐代码列（M7 第 4 步）：只能填本协会可售的，只能填给健管师
    const sellable = rows.some((r) => r.planCode.trim())
      ? await this.repo.sellablePlans(session)
      : new Map<string, string>();
    const planIdOf = (r: (typeof rows)[number]) =>
      r.planCode.trim() ? (sellable.get(r.planCode.trim().toLowerCase()) ?? null) : null;
    const formatErrors = rows.flatMap((r) => {
      const code =
        rowFormatError(r) ??
        (r.planCode.trim() && (r.role !== 'manager' || !planIdOf(r))
          ? ('plan_not_available' as const)
          : null);
      return code ? [{ row: r.row, code }] : [];
    });
    const bad = new Set(formatErrors.map((e) => e.row));
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * HOUR_MS);
    const tokens = new Map<number, string>();
    const checked = rows
      .filter((r) => !bad.has(r.row))
      .map((r) => {
        const token = randomBytes(32).toString('base64url');
        tokens.set(r.row, token);
        return { ...r, tokenHash: hashToken(token), planId: planIdOf(r) };
      });
    const result = await this.repo.importAccounts(
      session,
      checked,
      expiresAt,
      formatErrors.length === 0,
    );
    const rowErrors = [
      ...formatErrors,
      ...result.errors.map((e) => ({ row: e.row, code: e.code as AccountImportRowError })),
    ].sort((a, b) => a.row - b.row);
    const needed = rows.filter((r) => r.role === 'manager').length;
    const seats = { seatsLeft: result.seats_left, needed };
    // 以数据库是否写入为准：写入后的 seats_left 已扣减，不能再拿来比（租户审查 B1）
    if (!result.committed) {
      if (rowErrors.length > 0) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', { rowErrors, ...seats });
      }
      throw seatLimitReached(seats);
    }
    return {
      invites: [...result.accounts].map(([row, account]) => ({
        row,
        account,
        invitePath: `/#/invite/${tokens.get(row)}`,
        expiresAt: expiresAt.toISOString(),
      })),
    };
  }

  @Post('admin/accounts/:id/reinvite')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reinvite(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<InviteResponse> {
    requireAccountAdmin(session);
    const invite = newInvite();
    const account = await this.repo.reinvite(
      session,
      parseId(id),
      invite.tokenHash,
      invite.expiresAt,
    );
    if (!account) throw notFound();
    return {
      account,
      invitePath: `/#/invite/${invite.token}`,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  @Post('admin/accounts/:id/suspend')
  @HttpCode(200)
  async suspendAccount(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<AccountResponse> {
    requireAccountAdmin(session);
    if (id === session.userId) throw badRequest();
    const account = await this.repo.setAccountStatus(session, parseId(id), true);
    if (!account) throw notFound();
    return { account };
  }

  @Post('admin/accounts/:id/resume')
  @HttpCode(200)
  async resumeAccount(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<AccountResponse> {
    requireAccountAdmin(session);
    const account = await this.repo.setAccountStatus(session, parseId(id), false);
    if (!account) throw notFound();
    return { account };
  }

  @Get('admin/audit-log')
  async auditLog(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<AuditLogResponse> {
    return this.repo.auditLog(session, this.parseAuditQuery(session, query));
  }

  @Get('admin/audit-log/export')
  async exportAuditLog(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const q = this.parseAuditQuery(session, query);
    const { entries, truncated } = await this.repo.auditLog(session, q);
    const header = [
      'time',
      'operator_id',
      'actor_id',
      'actor_role',
      'object_type',
      'object_id',
      'action',
      'before',
      'after',
    ];
    const lines = entries.map((e) =>
      [
        e.createdAt,
        e.operatorId,
        e.actorId,
        e.actorRole,
        e.objectType,
        e.objectId,
        e.action,
        e.before,
        e.after,
      ]
        .map(csvCell)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // 超过 2000 条只导出最近的，响应头标明（租户审查 S6）
    res.setHeader('X-Audit-Truncated', truncated ? 'true' : 'false');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${q.from}-${q.to}.csv"`);
    // 带 BOM，表格软件按 UTF-8 打开中文不乱码
    res.send(`\uFEFF${[header.join(','), ...lines].join('\n')}\n`);
  }

  @Public()
  @Post('auth/invite/accept')
  @HttpCode(200)
  async accept(@Body() body: unknown, @Req() req: AuthedRequest): Promise<AcceptInviteResponse> {
    const ip = req.ip ?? 'unknown';
    // 按 IP 计数（租户审查 B2）：别的 IP 猜错令牌不影响这个 IP
    const key = `invite:${ip}`;
    if (this.limiter.isBlocked(ip, key)) throw tooManyRequests();
    const parsed = acceptInviteRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const role = await this.repo.acceptInvite(
      hashToken(parsed.data.token),
      await hashPassword(parsed.data.password),
    );
    if (!role) {
      this.limiter.recordFailure(ip, key);
      throw new ApiException(HttpStatus.GONE, 'invite_expired');
    }
    return { role };
  }

  /** 平台、运营商管理员能查审计日志（运营商只看本协会，行级安全保证）；其他角色 403 */
  private parseAuditQuery(session: ResolvedSession, query: unknown) {
    if (session.role !== 'platform_admin' && session.role !== 'operator_admin') throw forbidden();
    const parsed = auditLogQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw badRequest();
    return parsed.data;
  }
}
