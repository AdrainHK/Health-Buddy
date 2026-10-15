import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { loginRequestSchema, type MeResponse } from '@health-buddy/shared';
import type { CookieOptions, Response } from 'express';
import { ApiException, badRequest, unauthenticated } from '../common/api-error.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { TenantContext } from '../db/database.js';
import { UsersRepository } from '../users/users.repository.js';
import type { ResolvedSession } from './auth.repository.js';
import { AuthRepository } from './auth.repository.js';
import { CurrentSession, Public, type AuthedRequest } from './decorators.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';
import { SESSION_COOKIE, SESSION_TTL_MS, SessionService } from './session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthRepository,
    private readonly sessions: SessionService,
    private readonly users: UsersRepository,
    private readonly limiter: LoginRateLimiter,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const { email, password } = parsed.data;
    const ip = req.ip ?? 'unknown';

    if (this.limiter.isBlocked(ip, email)) {
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests');
    }

    const candidate = await this.auth.findLoginCandidate(email);
    // 无论邮箱是否存在都做一次密码验证，并且先验证密码再看账号状态，响应时间保持一致。
    const passwordOk = candidate
      ? await verifyPassword(candidate.passwordHash, password)
      : await verifyAgainstDummy(password);
    if (!candidate || !passwordOk || !candidate.active) {
      this.limiter.recordFailure(ip, email);
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    }
    this.limiter.reset(email);

    // 换发新会话前作废浏览器里可能存在的旧会话。
    const previous: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof previous === 'string') await this.sessions.revoke(previous);

    const { token } = await this.sessions.create(candidate.id);
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: SESSION_TTL_MS });

    const ctx: TenantContext = {
      userId: candidate.id,
      role: candidate.role,
      operatorId: candidate.operatorId,
      orgId: candidate.orgId,
    };
    return { user: await this.loadUser(ctx) };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') await this.sessions.revoke(token);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  async me(@CurrentSession() session: ResolvedSession): Promise<MeResponse> {
    return { user: await this.loadUser(session) };
  }

  private async loadUser(ctx: TenantContext) {
    const user = await this.users.findCurrent(ctx);
    if (!user) throw unauthenticated();
    return user;
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.config.secureCookies, path: '/' };
  }
}
