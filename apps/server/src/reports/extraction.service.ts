import { EventEmitter } from 'node:events';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { GatewayError } from '@health-buddy/ai-engine';
import {
  buildExtractionContent,
  REPORT_EXTRACTION_FORMAT_NAME,
  REPORT_EXTRACTION_PROMPT,
  reportExtractionOutputSchema,
  type ReportExtractionOutput,
} from '@health-buddy/skills';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import type { TenantContext } from '../db/database.js';
import { EXTRACTION_QUEUE, type ExtractionJob, type ExtractionQueue } from './extraction-queue.js';
import { splitPages, type ExtractionPage } from './file-inspect.js';
import type { RawItem } from './process-values.js';
import { ReportsRepository } from './reports.repository.js';
import { OBJECT_STORAGE, type ObjectStorage } from './storage.js';

/** 每页识别的超时 */
const PAGE_TIMEOUT_MS = 180_000;
/** 每页的输出上限：一页报告的指标不会太多 */
const PAGE_MAX_OUTPUT_TOKENS = 8000;

type FailureCategory =
  'not_a_report' | 'unreadable' | 'refused' | 'timeout' | 'too_large' | 'error';

class ExtractionFailure extends Error {
  constructor(readonly category: FailureCategory) {
    super(`extraction failed: ${category}`);
    this.name = 'ExtractionFailure';
  }
}

/** 队列任务读不到识别记录（不存在、属于别人、已不在排队中）时抛出，任务以失败结束 */
export class ExtractionJobRejected extends Error {
  constructor() {
    super('extraction job rejected');
    this.name = 'ExtractionJobRejected';
  }
}

/** 识别进度的进程内通知：识别记录有变化时，SSE 连接立刻去数据库读最新状态 */
@Injectable()
export class UploadEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  notify(uploadId: string): void {
    this.emitter.emit(uploadId);
  }

  subscribe(uploadId: string, fn: () => void): () => void {
    this.emitter.on(uploadId, fn);
    return () => this.emitter.off(uploadId, fn);
  }
}

/**
 * 报告识别（M2 规格 2.3 第 4–7 条、3.2）。队列任务只带 upload_id：
 * 1. 按 upload_id 找到发起人，以他的租户上下文认领识别记录（读不到就以失败结束，验收标准 22）；
 * 2. 逐页通过网关的 report_extraction 用途识别，不占用数据库事务；
 * 3. 写回前重新确认记录仍在识别中、客户仍归这位健管师，否则丢弃结果。
 *
 * 日志只记 upload_id、页数和结果类别，不记客户姓名、文件名、数值和原文。
 */
@Injectable()
export class ExtractionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ReportExtraction');

  constructor(
    private readonly repo: ReportsRepository,
    private readonly events: UploadEvents,
    @Inject(LLM_GATEWAY) private readonly gateway: AppGateway,
    @Inject(EXTRACTION_QUEUE) private readonly queue: ExtractionQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  onModuleInit(): void {
    if (this.queue.configured && this.storage) this.queue.start((job) => this.process(job));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }

  async process(job: ExtractionJob): Promise<void> {
    const { uploadId } = job;
    const ctx = await this.repo.requester(uploadId);
    if (!ctx) throw new ExtractionJobRejected();
    const claim = await this.repo.claimExtraction(ctx, uploadId);
    if (!claim) throw new ExtractionJobRejected();
    this.events.notify(uploadId);
    const started = Date.now();
    try {
      const result = await this.extract(ctx, uploadId, claim);
      if (!result) {
        this.log(uploadId, 'abandoned', claim.pageCount, started);
        return;
      }
      const saved = await this.repo.finishExtraction(ctx, uploadId, result);
      this.log(uploadId, saved ? 'done' : 'abandoned', claim.pageCount, started);
    } catch (err) {
      const category = err instanceof ExtractionFailure ? err.category : failureCategory(err);
      await this.repo.failExtraction(ctx, uploadId, category).catch(() => false);
      this.log(uploadId, `failed:${category}`, claim.pageCount, started);
    } finally {
      this.events.notify(uploadId);
    }
  }

  /** 逐页识别。记录中途被放弃或客户转出时返回 undefined */
  private async extract(
    ctx: TenantContext,
    uploadId: string,
    claim: {
      pageCount: number;
      files: { storageKey: string; mimeType: Parameters<typeof splitPages>[1] }[];
    },
  ): Promise<
    { reportDate: string | null; institution: string | null; items: RawItem[] } | undefined
  > {
    if (!this.storage) throw new ExtractionFailure('error');
    const pages: ExtractionPage[] = [];
    for (const file of claim.files) {
      const buf = await this.storage.get(file.storageKey);
      pages.push(...(await splitPages(buf, file.mimeType)));
    }
    if (!pages.length || pages.length !== claim.pageCount) throw new ExtractionFailure('error');

    const outputs: ReportExtractionOutput[] = [];
    for (const [index, page] of pages.entries()) {
      if (!(await this.repo.setProgress(ctx, uploadId, index + 1))) return undefined;
      this.events.notify(uploadId);
      outputs.push(await this.extractPage(ctx, page, index + 1, pages.length));
    }

    const reportPages = outputs
      .map((o, i) => ({ output: o, page: i + 1 }))
      .filter((p) => p.output.category === 'report');
    if (!reportPages.length) {
      throw new ExtractionFailure(
        outputs.every((o) => o.category === 'not_a_report') ? 'not_a_report' : 'unreadable',
      );
    }
    const items: RawItem[] = reportPages.flatMap(({ output, page }) =>
      output.items
        .filter((i) => i.indicator.trim())
        .map((i) => ({
          rawName: i.indicator,
          rawValue: i.value,
          rawUnit: i.unit,
          refText: i.referenceRange,
          page,
          snippet: i.snippet,
          unreadable: i.unreadable,
        })),
    );
    if (!items.length) throw new ExtractionFailure('unreadable');
    return {
      reportDate:
        reportPages.map((p) => validDate(p.output.reportDate)).find((d) => d !== null) ?? null,
      institution: reportPages.map((p) => p.output.institution?.trim()).find((t) => t) ?? null,
      items,
    };
  }

  private async extractPage(
    ctx: TenantContext,
    page: ExtractionPage,
    pageNumber: number,
    pageCount: number,
  ): Promise<ReportExtractionOutput> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PAGE_TIMEOUT_MS);
    try {
      const result = await this.gateway.completeStructured(
        ctx,
        {
          route: 'report_extraction',
          system: REPORT_EXTRACTION_PROMPT,
          messages: [
            {
              role: 'user',
              content: buildExtractionContent(
                page.kind === 'image'
                  ? {
                      kind: 'image',
                      mediaType: page.mediaType,
                      base64: page.data.toString('base64'),
                    }
                  : { kind: 'pdf', base64: page.data.toString('base64') },
                pageNumber,
                pageCount,
              ),
            },
          ],
          maxOutputTokens: PAGE_MAX_OUTPUT_TOKENS,
        },
        { name: REPORT_EXTRACTION_FORMAT_NAME, schema: reportExtractionOutputSchema },
        controller.signal,
      );
      if (result.status === 'refused') throw new ExtractionFailure('refused');
      return result.data;
    } catch (err) {
      if (timedOut) throw new ExtractionFailure('timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private log(uploadId: string, outcome: string, pages: number, started: number): void {
    this.logger.log(
      `report extraction ${JSON.stringify({ uploadId, outcome, pages, durationMs: Date.now() - started })}`,
    );
  }
}

function failureCategory(err: unknown): FailureCategory {
  if (err instanceof GatewayError) {
    if (err.kind === 'timeout') return 'timeout';
    if (err.status === 413) return 'too_large';
  }
  return 'error';
}

/** 模型给的日期只接受合法的 YYYY-MM-DD，否则留空由健管师填写 */
function validDate(text: string | null): string | null {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) return null;
  if (d.getUTCFullYear() < 1950 || d.getTime() > Date.now() + 24 * 3600 * 1000) return null;
  return text;
}
