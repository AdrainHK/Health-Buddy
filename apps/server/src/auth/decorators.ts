import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ResolvedSession } from './auth.repository.js';
import { unauthenticated } from '../common/api-error.js';

export const IS_PUBLIC = 'hb:isPublic';

/** 标记无需登录的接口。默认所有接口都要求登录。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthedRequest = Request & { session?: ResolvedSession };

/** 取当前会话（包含租户上下文）。只能用在需要登录的接口上。 */
export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ResolvedSession => {
    const session = ctx.switchToHttp().getRequest<AuthedRequest>().session;
    if (!session) throw unauthenticated();
    return session;
  },
);
