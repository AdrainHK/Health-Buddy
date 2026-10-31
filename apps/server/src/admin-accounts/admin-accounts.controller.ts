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
  acceptInviteRequestSchema,
  auditLogQuerySchema,
  createOperatorRequestSchema,
  inviteAccountRequestSchema,
  suspendOperatorRequestSchema,
  updateOperatorRequestSchema,
  type AcceptInviteResponse,
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
import { AdminAccountsRepository } from './admin-accounts.repository.js';

const idSchema = z.uuid();
const HOUR_MS = 3_600_000;

/** 只有平台管理员（M7 第 1 步）；其他后台角色和健管师 403（按角色拒绝，不涉及具体资源） */
function requirePlatform(session: ResolvedSession): void {
  if (session.role !== 'platform_admin') throw forbidden();
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
 * - /api/admin/accounts/:id/{suspend,resume,reinvite}：停用、恢复账号、重发邀请（找回密码）——只有平台；
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

  @Post('admin/accounts/:id/reinvite')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reinvite(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<InviteResponse> {
    requirePlatform(session);
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
    requirePlatform(session);
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
    requirePlatform(session);
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
