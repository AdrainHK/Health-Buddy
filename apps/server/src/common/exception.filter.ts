import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ApiErrorCode } from '@health-buddy/shared';
import type { Response } from 'express';
import { ApiException } from './api-error.js';

const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'not_found',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too_many_requests',
};

/** 描述一个未预期的错误，只保留类型和数据库错误码，不含错误详情（可能带数据）。 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = 'code' in err && typeof err.code === 'string' ? ` code=${err.code}` : '';
  return `${err.name}${code}`;
}

/**
 * 全局异常处理：所有错误都转成 { error: 错误码 }。
 * 未预期的错误只记录错误类型，不记录消息和堆栈里可能出现的客户数据（红线 2）。
 * 403 也按 not_found 返回，不暴露数据是否存在。
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ApiException) {
      res.status(exception.getStatus()).json({ error: exception.code });
      return;
    }
    if (exception instanceof HttpException) {
      const raw = exception.getStatus();
      const status = raw === HttpStatus.FORBIDDEN ? HttpStatus.NOT_FOUND : raw;
      res.status(status).json({ error: CODE_BY_STATUS[status] ?? 'internal_error' });
      return;
    }
    this.logger.error(`Unhandled error: ${describeError(exception)}`);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'internal_error' });
  }
}
