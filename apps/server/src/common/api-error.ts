import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@health-buddy/shared';

/** 统一的接口错误：响应体只有错误码，不带任何数据。 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
  ) {
    super({ error: code }, status);
  }
}

export const notFound = () => new ApiException(HttpStatus.NOT_FOUND, 'not_found');
export const unauthenticated = () => new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated');
export const badRequest = () => new ApiException(HttpStatus.BAD_REQUEST, 'bad_request');
export const conflict = () => new ApiException(HttpStatus.CONFLICT, 'conflict');
export const tooManyRequests = () =>
  new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests');
