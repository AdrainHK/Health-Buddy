import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@health-buddy/shared';

/**
 * 统一的接口错误：响应体是错误码，加上可选的结构化细节（如确认被拒绝的原因）。
 * 细节只能是枚举值和位置，不能带客户数据。
 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super({ ...details, error: code }, status);
  }
}

export const notFound = () => new ApiException(HttpStatus.NOT_FOUND, 'not_found');
export const unauthenticated = () => new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated');
export const badRequest = () => new ApiException(HttpStatus.BAD_REQUEST, 'bad_request');
export const conflict = (details?: Record<string, unknown>) =>
  new ApiException(HttpStatus.CONFLICT, 'conflict', details);
export const tooManyRequests = () =>
  new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests');
