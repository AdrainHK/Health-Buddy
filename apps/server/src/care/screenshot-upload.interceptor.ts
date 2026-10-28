import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { CHAT_SCREENSHOT_LIMITS } from '@health-buddy/shared';
import type { Response } from 'express';
import multer, { MulterError } from 'multer';
import { from, switchMap, type Observable } from 'rxjs';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/decorators.js';
import { badRequest, notFound, payloadTooLarge, tooManyRequests } from '../common/api-error.js';
import { LLM_RATE_LIMITER, type LlmRateLimiter } from '../workbench/llm-rate-limiter.js';
import { VisitMaterialsRepository } from './visit-materials.repository.js';

/** 上传表单里截图字段的名称 */
export const SCREENSHOT_FIELD = 'files';

/**
 * 聊天截图转写前的检查（M5 规格 2.9“聊天截图”），在解析请求体之前完成：只有健管师能用
 * （其他角色按“不存在”处理）；客户必须是自己的（否则 404，不读请求体）；计入每分钟的防滥用上限。
 * 截图只在内存里解析，不落盘、不写存储。
 */
@Injectable()
export class ScreenshotUploadInterceptor implements NestInterceptor {
  private readonly parse = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: CHAT_SCREENSHOT_LIMITS.maxFileBytes,
      files: CHAT_SCREENSHOT_LIMITS.maxFiles,
      fields: 2,
      fieldSize: 20,
      parts: CHAT_SCREENSHOT_LIMITS.maxFiles + 2,
    },
  }).array(SCREENSHOT_FIELD, CHAT_SCREENSHOT_LIMITS.maxFiles);

  constructor(
    @Inject(LLM_RATE_LIMITER) private readonly limiter: LlmRateLimiter,
    private readonly materials: VisitMaterialsRepository,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const session = req.session;
    if (session?.role !== 'manager') throw notFound();
    const parsedId = z.uuid().safeParse(req.params.id);
    if (!parsedId.success) throw notFound();
    const clientId = parsedId.data;
    const ready = (async () => {
      // 只看客户归属（同意在控制器里看，它在请求体里）
      if ((await this.materials.checkTranscribe(session, clientId, true)) === 'not_found') {
        throw notFound();
      }
      if (!this.limiter.tryAcquire(session.userId)) throw tooManyRequests();
      await new Promise<void>((resolve, reject) => {
        this.parse(req, res, (err: unknown) => (err ? reject(toApiError(err)) : resolve()));
      });
    })();
    return from(ready).pipe(switchMap(() => next.handle()));
  }
}

/** multer 的错误转成统一错误码；错误消息里可能有字段名，不往外带 */
function toApiError(err: unknown) {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return payloadTooLarge('file_too_large');
    if (err.code === 'LIMIT_FILE_COUNT') return payloadTooLarge('too_many_files');
    if (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === SCREENSHOT_FIELD) {
      return payloadTooLarge('too_many_files');
    }
  }
  return badRequest();
}
