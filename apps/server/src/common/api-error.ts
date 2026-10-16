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
/** 按角色拒绝（不针对某个资源，所以不会泄露资源是否存在） */
export const forbidden = () => new ApiException(HttpStatus.FORBIDDEN, 'forbidden');
export const badRequest = () => new ApiException(HttpStatus.BAD_REQUEST, 'bad_request');
export const conflict = (details?: Record<string, unknown>) =>
  new ApiException(HttpStatus.CONFLICT, 'conflict', details);
export const tooManyRequests = (reasons?: string[]) =>
  new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests', reasons ? { reasons } : {});
export const payloadTooLarge = (reason: string) =>
  new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, 'payload_too_large', { reasons: [reason] });
export const unsupportedMediaType = () =>
  new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_media_type', {
    reasons: ['unsupported_type'],
  });
/** 功能依赖的服务（对象存储、识别队列）还没有配置 */
export const notConfigured = () =>
  new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'not_configured');
