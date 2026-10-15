import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { unauthenticated } from '../common/api-error.js';
import { IS_PUBLIC, type AuthedRequest } from './decorators.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/** 全局守卫：除了标记为 @Public 的接口，都必须带有效会话。 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === 'string' ? await this.sessions.resolve(token) : undefined;
    if (!session) throw unauthenticated();
    req.session = session;
    return true;
  }
}
