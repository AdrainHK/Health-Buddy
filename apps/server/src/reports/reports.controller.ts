import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  addExtractedValueRequestSchema,
  correctIndicatorRequestSchema,
  REPORT_UPLOAD_LIMITS,
  updateExtractedValueRequestSchema,
  verifyUploadRequestSchema,
  type ExtractedValueResponse,
  type IndicatorTrendResponse,
  type ReportListResponse,
  type ReportResponse,
  type ReportUploadListResponse,
  type ReportUploadResponse,
  type ReportUploadStreamEvent,
  type ReportUploadSummary,
} from '@health-buddy/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import {
  badRequest,
  conflict,
  notConfigured,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unsupportedMediaType,
} from '../common/api-error.js';
import { describeError } from '../common/exception.filter.js';
import { requireManager } from '../common/manager-only.js';
import { LLM_RATE_LIMITER, type LlmRateLimiter } from '../workbench/llm-rate-limiter.js';
import { EXTRACTION_QUEUE, type ExtractionQueue } from './extraction-queue.js';
import { UploadEvents } from './extraction.service.js';
import { inspectFile, previewPage } from './file-inspect.js';
import { ReportsRepository } from './reports.repository.js';
import { OBJECT_STORAGE, type ObjectStorage } from './storage.js';
import { ReportUploadInterceptor } from './upload.interceptor.js';
import type { InspectedFileUpload } from './upload-types.js';

const idSchema = z.uuid();
const CODE_RE = /^[a-z][a-z0-9_]{1,40}$/;

/** 格式不对、不存在、属于别的租户，一律返回“不存在” */
function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/** 已核对的报告：健管师和本机构管理员可读（Q14）；运营商和平台按“不存在”处理 */
function requireReportReader(session: ResolvedSession): void {
  if (session.role !== 'manager' && session.role !== 'org_admin') throw notFound();
}

/** SSE 连接最长保持多久；识别还没结束时前端会重新连接 */
const STREAM_MAX_MS = 10 * 60 * 1000;
/** 没有进程内通知时（多实例），多久查一次数据库 */
const STREAM_POLL_MS = 2000;

/** 原文件名只用于显示：去掉路径、控制字符，截到 255 个字符 */
function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return [...(cleaned || 'file')].slice(0, 255).join('');
}

/**
 * 报告上传、识别和核对接口（M2 规格 3.4）。
 *
 * 识别记录、原件和待核对结果只给服务该客户的健管师；机构管理员、运营商、平台一律 404（Q14）。
 * 上传和重新识别依赖对象存储和队列，没有配置时返回 503 not_configured，其他接口照常。
 * 日志只记 id、状态和数量，不记客户姓名、文件原名、数值和原文。
 */
@Controller()
export class ReportUploadsController {
  private readonly logger = new Logger('ReportUploads');

  constructor(
    private readonly repo: ReportsRepository,
    private readonly events: UploadEvents,
    @Inject(EXTRACTION_QUEUE) private readonly queue: ExtractionQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(LLM_RATE_LIMITER) private readonly limiter: LlmRateLimiter,
  ) {}

  /**
   * 上传报告（multipart，字段 files，可多个；可带 taskId）。按文件内容判断类型，
   * 校验数量、大小和页数（Q2、Q3）；不通过时不保存任何东西。
   */
  @Post('clients/:id/report-uploads')
  @UseInterceptors(ReportUploadInterceptor)
  async upload(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ReportUploadResponse> {
    const clientId = parseId(id);
    const storage = this.storage;
    if (!storage) throw notConfigured();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawTask = body.taskId;
    let taskId: string | null = null;
    if (rawTask !== undefined && rawTask !== '') {
      if (typeof rawTask !== 'string' || !idSchema.safeParse(rawTask).success) throw badRequest();
      taskId = rawTask;
    }
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!Array.isArray(files) || files.length === 0) throw badRequest();
    if (files.length > REPORT_UPLOAD_LIMITS.maxFiles) throw payloadTooLarge('too_many_files');

    const inspected: InspectedFileUpload[] = [];
    for (const file of files) {
      const result = await inspectFile(file.buffer);
      if (!result.ok) {
        if (result.reason === 'file_too_large') throw payloadTooLarge('file_too_large');
        throw unsupportedMediaType();
      }
      inspected.push({
        buffer: file.buffer,
        inspected: result.file,
        originalName: cleanFileName(file.originalname),
      });
    }
    const pages = inspected.reduce((n, f) => n + f.inspected.pageCount, 0);
    if (pages > REPORT_UPLOAD_LIMITS.maxPages) throw payloadTooLarge('too_many_pages');
    if (new Set(inspected.map((f) => f.inspected.sha256)).size !== inspected.length) {
      throw conflict({ reasons: ['duplicate_file'], existing: null });
    }

    const upload = await this.repo.createUpload(
      session,
      { clientId, taskId, files: inspected },
      storage,
    );
    await this.enqueue(session, upload.id, 1);
    this.logger.log(
      `report uploaded ${JSON.stringify({ uploadId: upload.id, files: inspected.length, pages })}`,
    );
    return { upload: (await this.repo.getUpload(session, upload.id)) ?? upload };
  }

  /** 某位客户的识别记录（核对标签和角标）。只有服务该客户的健管师 */
  @Get('clients/:id/report-uploads')
  async list(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportUploadListResponse> {
    requireManager(session);
    const uploads = await this.repo.listUploads(session, parseId(id));
    if (!uploads) throw notFound();
    return { uploads };
  }

  @Get('report-uploads/:id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportUploadResponse> {
    requireManager(session);
    const upload = await this.repo.getUpload(session, parseId(id));
    if (!upload) throw notFound();
    return { upload };
  }

  /**
   * 识别进度（SSE）。只推状态和页数：progress（还在排队或识别中）、done（待核对、失败等）。
   * 别人的识别记录 404，不建立流。
   */
  @Get('report-uploads/:id/events')
  async stream(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const uploadId = parseId(id);
    const first = await this.repo.uploadSummary(session, uploadId);
    if (!first) throw notFound();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: ReportUploadStreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const terminal = (u: ReportUploadSummary) => u.status !== 'queued' && u.status !== 'processing';

    let closed = false;
    let last = '';
    let wake: (() => void) | undefined;
    const unsubscribe = this.events.subscribe(uploadId, () => wake?.());
    res.on('close', () => {
      closed = true;
      wake?.();
    });
    const deadline = Date.now() + STREAM_MAX_MS;
    let current: ReportUploadSummary | undefined = first;
    try {
      while (!closed && current) {
        const key = `${current.status}:${current.progressPage}:${current.attempts}`;
        if (terminal(current)) {
          send({ type: 'done', upload: current });
          break;
        }
        if (key !== last) {
          send({ type: 'progress', upload: current });
          last = key;
        }
        if (Date.now() > deadline) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STREAM_POLL_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (closed) break;
        current = await this.repo.uploadSummary(session, uploadId);
      }
    } catch (err) {
      this.logger.error(`upload stream failed ${describeError(err)}`);
      send({ type: 'error', kind: 'internal_error' });
    } finally {
      unsubscribe();
      res.end();
    }
  }

  /** 重新识别（失败后，最多 3 次；计入每分钟上限和每天的页数） */
  @Post('report-uploads/:id/retry')
  @HttpCode(200)
  async retry(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportUploadResponse> {
    requireManager(session);
    const uploadId = parseId(id);
    if (!this.queue.configured || !this.storage) throw notConfigured();
    if (!this.limiter.tryAcquire(session.userId)) throw tooManyRequests();
    const { upload } = await this.repo.retry(session, uploadId);
    await this.enqueue(session, uploadId, upload.attempts);
    const detail = await this.repo.getUpload(session, uploadId);
    if (!detail) throw notFound();
    return { upload: detail };
  }

  @Post('report-uploads/:id/discard')
  @HttpCode(200)
  async discard(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportUploadResponse> {
    requireManager(session);
    const upload = await this.repo.discard(session, parseId(id));
    this.events.notify(upload.id);
    return { upload };
  }

  /** 修改一项，或勾选“已核对”，或删除识别错的行 */
  @Patch('report-uploads/:id/values/:valueId')
  async updateValue(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
    @Body() body: unknown,
  ): Promise<ExtractedValueResponse> {
    requireManager(session);
    const uploadId = parseId(id);
    const value = parseId(valueId);
    const parsed = updateExtractedValueRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return this.repo.updateValue(session, uploadId, value, parsed.data);
  }

  /** 补录一项 */
  @Post('report-uploads/:id/values')
  async addValue(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ExtractedValueResponse> {
    requireManager(session);
    const uploadId = parseId(id);
    const parsed = addExtractedValueRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return this.repo.addValue(session, uploadId, parsed.data);
  }

  /** 确认核对，写入正式报告（规格 2.4）。版本号过期、未逐行勾选、未知悉危急指标等返回 409 */
  @Post('report-uploads/:id/verify')
  @HttpCode(200)
  async verify(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReportUploadResponse> {
    requireManager(session);
    const uploadId = parseId(id);
    const parsed = verifyUploadRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const { upload, critical } = await this.repo.verify(session, uploadId, parsed.data);
    this.logger.log(
      `report verified ${JSON.stringify({
        uploadId,
        values: upload.values.filter((v) => v.reviewStatus !== 'deleted').length,
        criticalFlags: critical.length,
      })}`,
    );
    return { upload };
  }

  /**
   * 原件预览（规格 3.4）：后端读对象存储后转发，不给出直链；响应不缓存（验收标准 23）。
   * 每次查看记一条 file_viewed。别人的文件、机构管理员、运营商、平台 → 404。
   */
  @Get('report-files/:id/content')
  async content(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Query('page') pageParam: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    requireManager(session);
    const fileId = parseId(id);
    const page = pageParam === undefined ? 1 : Number(pageParam);
    if (!Number.isInteger(page) || page < 1 || page > REPORT_UPLOAD_LIMITS.maxPages) {
      throw badRequest();
    }
    if (!this.storage) throw notConfigured();
    const file = await this.repo.openFile(session, fileId, page);
    if (!file) throw notFound();
    const preview = await previewPage(await this.storage.get(file.storageKey), file.mimeType, page);
    if (!preview) throw notFound();
    const ext =
      preview.contentType === 'application/pdf' ? 'pdf' : preview.contentType.split('/')[1];
    res.setHeader('Content-Type', preview.contentType);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    // 文件名是固定的，不用原文件名
    res.setHeader('Content-Disposition', `inline; filename="report-page-${page}.${ext}"`);
    res.setHeader('Content-Length', String(preview.body.length));
    res.end(preview.body);
  }

  /** 入队；入队失败时把记录改成失败并退还预占的页数，健管师可以重新识别 */
  private async enqueue(session: ResolvedSession, uploadId: string, attempt: number) {
    try {
      await this.queue.enqueue({ uploadId, attempt });
    } catch (err) {
      this.logger.error(
        `enqueue failed ${JSON.stringify({ uploadId, error: describeError(err) })}`,
      );
      await this.repo.failEnqueue(session, uploadId).catch(() => false);
    }
  }
}

/** 已核对的报告、指标更正和趋势（规格 2.2、2.4、3.4） */
@Controller()
export class ReportsController {
  constructor(private readonly repo: ReportsRepository) {}

  @Get('clients/:id/reports')
  async list(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportListResponse> {
    requireReportReader(session);
    const reports = await this.repo.listReports(session, parseId(id));
    if (!reports) throw notFound();
    return { reports };
  }

  @Get('reports/:id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ReportResponse> {
    requireReportReader(session);
    const report = await this.repo.getReport(session, parseId(id));
    if (!report) throw notFound();
    return { report };
  }

  /** 更正一项已核对的指标：旧值保留，可在更正历史里看到。机构管理员只读 → 404 */
  @Post('reports/:id/indicators/:indicatorId/correct')
  @HttpCode(200)
  async correct(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('indicatorId') indicatorId: string,
    @Body() body: unknown,
  ): Promise<ReportResponse> {
    requireManager(session);
    const reportId = parseId(id);
    const indicator = parseId(indicatorId);
    const parsed = correctIndicatorRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { report: await this.repo.correctIndicator(session, reportId, indicator, parsed.data) };
  }

  @Get('clients/:id/indicators/:code/trend')
  async trend(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('code') code: string,
  ): Promise<IndicatorTrendResponse> {
    requireReportReader(session);
    const clientId = parseId(id);
    if (!CODE_RE.test(code)) throw notFound();
    const trend = await this.repo.trend(session, clientId, code);
    if (!trend) throw notFound();
    return trend;
  }
}
