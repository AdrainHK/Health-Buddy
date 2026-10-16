import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { REPORT_UPLOAD_LIMITS } from '@health-buddy/shared';
import type { Response } from 'express';
import multer, { MulterError } from 'multer';
import { from, switchMap, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/decorators.js';
import {
  badRequest,
  notConfigured,
  notFound,
  payloadTooLarge,
  tooManyRequests,
} from '../common/api-error.js';
import { LLM_RATE_LIMITER, type LlmRateLimiter } from '../workbench/llm-rate-limiter.js';
import { EXTRACTION_QUEUE, type ExtractionQueue } from './extraction-queue.js';
import { OBJECT_STORAGE, type ObjectStorage } from './storage.js';

/** 上传表单里文件字段的名称 */
export const UPLOAD_FIELD = 'files';

/**
 * 上传报告前的检查（规格 2.3 第 3 条、3.4“其他约定”），在解析请求体之前完成：
 * 只有健管师能上传（其他角色按“不存在”处理）；对象存储或队列没有配置时直接返回“未配置”；
 * 上传计入每分钟 20 次的防滥用上限。然后在内存里解析 multipart，超出数量和大小直接拒绝，
 * 不落盘、不写存储。
 */
@Injectable()
export class ReportUploadInterceptor implements NestInterceptor {
  private readonly parse = multer({
    storage: multer.memoryStorage(),
    // 文件名按 UTF-8 解码（中文文件名），只用于显示
    defParamCharset: 'utf8',
    limits: {
      fileSize: REPORT_UPLOAD_LIMITS.maxFileBytes,
      files: REPORT_UPLOAD_LIMITS.maxFiles,
      fields: 4,
      fieldSize: 200,
      parts: REPORT_UPLOAD_LIMITS.maxFiles + 4,
    },
  }).array(UPLOAD_FIELD, REPORT_UPLOAD_LIMITS.maxFiles);

  constructor(
    @Inject(LLM_RATE_LIMITER) private readonly limiter: LlmRateLimiter,
    @Inject(EXTRACTION_QUEUE) private readonly queue: ExtractionQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    if (req.session?.role !== 'manager') throw notFound();
    if (!this.queue.configured || !this.storage) throw notConfigured();
    if (!this.limiter.tryAcquire(req.session.userId)) throw tooManyRequests();
    const parsed = new Promise<void>((resolve, reject) => {
      this.parse(req, res, (err: unknown) => (err ? reject(toApiError(err)) : resolve()));
    });
    return from(parsed).pipe(switchMap(() => next.handle()));
  }
}

/** multer 的错误转成统一错误码；错误消息里可能有字段名，不往外带 */
function toApiError(err: unknown) {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return payloadTooLarge('file_too_large');
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return err.field === UPLOAD_FIELD || err.code === 'LIMIT_FILE_COUNT'
        ? payloadTooLarge('too_many_files')
        : badRequest();
    }
  }
  return badRequest();
}
