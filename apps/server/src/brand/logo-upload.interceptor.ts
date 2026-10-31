import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { BRAND_LOGO_MAX_BYTES } from '@health-buddy/shared';
import type { Response } from 'express';
import multer, { MulterError } from 'multer';
import { from, switchMap, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/decorators.js';
import { badRequest, forbidden, notConfigured, payloadTooLarge } from '../common/api-error.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../reports/storage.js';

/** 上传表单里 Logo 字段的名称 */
export const LOGO_FIELD = 'file';

/**
 * Logo 上传前的检查，在解析请求体之前完成：只有运营商管理员（其他角色 403，平台不代改，Q16）；
 * 对象存储没配置时 503。文件只在内存里解析，不落盘。
 */
@Injectable()
export class LogoUploadInterceptor implements NestInterceptor {
  private readonly parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BRAND_LOGO_MAX_BYTES, files: 1, fields: 0, parts: 1 },
  }).single(LOGO_FIELD);

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    if (req.session?.role !== 'operator_admin' || !req.session.operatorId) throw forbidden();
    if (!this.storage) throw notConfigured();
    const ready = new Promise<void>((resolve, reject) => {
      this.parse(req, res, (err: unknown) => (err ? reject(toApiError(err)) : resolve()));
    });
    return from(ready).pipe(switchMap(() => next.handle()));
  }
}

function toApiError(err: unknown) {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return payloadTooLarge('file_too_large');
  }
  return badRequest();
}
