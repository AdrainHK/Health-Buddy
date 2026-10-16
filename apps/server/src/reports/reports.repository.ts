import { Inject, Injectable } from '@nestjs/common';
import {
  abnormalFromColumns,
  detectCriticalFlags,
  needsAttention,
  REPORT_UPLOAD_LIMITS,
  type AddExtractedValueRequest,
  type CorrectIndicatorRequest,
  type CriticalFlag,
  type ExtractedValue,
  type ExtractedValueFlag,
  type IndicatorCode,
  type IndicatorTrendResponse,
  type Observation,
  type Report,
  type ReportIndicator,
  type ReportListItem,
  type ReportMimeType,
  type ReportUpload,
  type ReportUploadSummary,
  type UpdateExtractedValueRequest,
  type VerifyRejection,
  type VerifyUploadRequest,
} from '@health-buddy/shared';
import { type ExpressionBuilder, type Selectable, type Updateable } from 'kysely';
import { badRequest, conflict, notFound, tooManyRequests } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { dbErrorCode } from '../common/db-error.js';
import {
  asDate,
  claimStaleBefore,
  currentDate,
  reportQuotaRefund,
  reportUploadRequester,
  storagePurgeClaim,
  storagePurgeDone,
} from '../db/report-functions.js';
import type {
  ExtractedValuesTable,
  ReportEventAction,
  ReportIndicatorsTable,
} from '../db/types.js';
import type { InspectedFileUpload } from './upload-types.js';
import {
  isCatalogCode,
  markConflicts,
  processItem,
  type ProcessedItem,
  type RawItem,
} from './process-values.js';
import { newStorageKey, type ObjectStorage } from './storage.js';

/** 列表的上限，防止一位客户的数据把响应撑得太大 */
const UPLOAD_LIST_LIMIT = 100;
const REPORT_LIST_LIMIT = 200;
const TREND_LIMIT = 200;

/** 识别结果写库前按列的长度截断（模型输出不保证长度） */
const LIMITS = { name: 100, value: 50, unit: 30, ref: 60, snippet: 200, institution: 100 } as const;

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = text.trim();
  return t ? [...t].slice(0, max).join('') : null;
}

const uploadSummaryColumns = [
  'u.id',
  'u.client_id',
  'u.task_id',
  'u.status',
  'u.failure_category',
  'u.attempts',
  'u.page_count',
  'u.progress_page',
  'u.report_id',
  'u.created_at',
] as const;

type UploadSummaryRow = {
  id: string;
  client_id: string;
  task_id: string | null;
  status: ReportUploadSummary['status'];
  failure_category: ReportUploadSummary['failureCategory'];
  attempts: number;
  page_count: number;
  progress_page: number;
  report_id: string | null;
  created_at: Date;
};

export function selectUploadSummary(trx: TenantTransaction) {
  return trx.selectFrom('report_uploads as u').select(uploadSummaryColumns);
}

export function toUploadSummary(row: UploadSummaryRow): ReportUploadSummary {
  return {
    id: row.id,
    clientId: row.client_id,
    taskId: row.task_id,
    status: row.status,
    failureCategory: row.failure_category,
    attempts: row.attempts,
    pageCount: row.page_count,
    progressPage: row.progress_page,
    reportId: row.report_id,
    createdAt: row.created_at.toISOString(),
  };
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toExtractedValue(row: Selectable<ExtractedValuesTable>): ExtractedValue {
  const value = num(row.value);
  return {
    id: row.id,
    seq: row.seq,
    rawName: row.raw_name,
    code: row.code,
    rawValue: row.raw_value,
    rawUnit: row.raw_unit,
    value,
    unit: row.unit,
    refLow: num(row.ref_low),
    refHigh: num(row.ref_high),
    refText: row.ref_text,
    page: row.page,
    sourceSnippet: row.source_snippet,
    flags: row.flags,
    reviewStatus: row.review_status,
    attention: needsAttention(row.flags),
    abnormal: abnormalFromColumns(value, num(row.ref_low), num(row.ref_high), row.ref_text),
  };
}

function toIndicator(row: Selectable<ReportIndicatorsTable>): ReportIndicator {
  return {
    id: row.id,
    code: row.code,
    rawName: row.raw_name,
    value: num(row.value),
    unit: row.unit,
    originalValue: row.original_value,
    originalUnit: row.original_unit,
    refLow: num(row.ref_low),
    refHigh: num(row.ref_high),
    refText: row.ref_text,
    abnormal: row.abnormal,
    supersededBy: row.superseded_by,
    createdAt: row.created_at.toISOString(),
  };
}

function isoDate<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  column: Parameters<ExpressionBuilder<DB, TB>['ref']>[0],
) {
  return eb.fn<string>('to_char', [eb.ref(column), eb.val('YYYY-MM-DD')]);
}

function tenantScope(ctx: TenantContext) {
  return { operator_id: ctx.operatorId ?? '', org_id: ctx.orgId, manager_id: ctx.userId };
}

export interface ClaimedExtraction {
  pageCount: number;
  files: { storageKey: string; mimeType: ReportMimeType; pageCount: number }[];
}

export interface ExtractionResult {
  reportDate: string | null;
  institution: string | null;
  items: RawItem[];
}

/** 确认核对被拒绝：409，带原因、涉及的行和危急指标（只给本人看，不进日志） */
export function verifyRejected(details: Omit<VerifyRejection, 'error'>) {
  return conflict(details);
}

/**
 * 报告上传、识别和核对的数据库操作（M2 规格 2.3、2.4、2.6、3.2、3.4）。
 *
 * 全部经过 withTenant，可见范围由行级安全决定：识别记录、原件和待核对结果只对服务该客户的
 * 健管师可见；正式报告和指标机构管理员也能读（只读，Q14）。看不到一律按“不存在”处理。
 * 长时间的识别不占用事务：认领、写进度、写结果各是一个短事务。
 */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 新建识别记录并保存原件。先在事务里确认客户和任务归属、重复文件、当天页数，
   * 全部通过后才写对象存储；存储失败时事务回滚，已写的对象删掉，不留记录。
   */
  async createUpload(
    ctx: TenantContext,
    input: { clientId: string; taskId: string | null; files: InspectedFileUpload[] },
    storage: ObjectStorage,
  ): Promise<ReportUpload> {
    const written: string[] = [];
    try {
      return await withTenant(this.db, ctx, async (trx) => {
        if (!(await ownClient(trx, ctx, input.clientId))) throw notFound();
        if (input.taskId) {
          const task = await trx
            .selectFrom('tasks')
            .select(['id', 'client_id', 'detached_reason'])
            .where('id', '=', input.taskId)
            .forUpdate()
            .executeTakeFirst();
          if (!task || (task.client_id !== null && task.client_id !== input.clientId)) {
            throw notFound();
          }
          if (task.detached_reason) throw conflict({ reasons: ['read_only'] });
          if (task.client_id === null) {
            // 在还没关联客户的任务里上传：和 @ 客户一样把任务关联到这位客户（Q6）
            await trx
              .updateTable('tasks')
              .set({ client_id: input.clientId })
              .where('id', '=', input.taskId)
              .execute();
          }
        }
        // 同一文件重复上传（文件指纹相同）直接提示“已上传过”（Q17）；已放弃的不算
        const dup = await trx
          .selectFrom('report_files as f')
          .innerJoin('report_uploads as u', 'u.id', 'f.upload_id')
          .select('f.id')
          .where('f.client_id', '=', input.clientId)
          .where(
            'f.sha256',
            'in',
            input.files.map((f) => f.inspected.sha256),
          )
          .where('u.status', '<>', 'discarded')
          .executeTakeFirst();
        if (dup) throw conflict({ reasons: ['duplicate_file'] });

        const pageCount = input.files.reduce((n, f) => n + f.inspected.pageCount, 0);
        await reservePages(trx, ctx, pageCount);

        const upload = await trx
          .insertInto('report_uploads')
          .values({
            ...tenantScope(ctx),
            client_id: input.clientId,
            task_id: input.taskId,
            page_count: pageCount,
            uploaded_by: ctx.userId,
            requested_by: ctx.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const [seq, file] of input.files.entries()) {
          const key = newStorageKey();
          await trx
            .insertInto('report_files')
            .values({
              ...tenantScope(ctx),
              client_id: input.clientId,
              upload_id: upload.id,
              seq,
              storage_key: key,
              mime_type: file.inspected.mimeType,
              size_bytes: file.buffer.length,
              page_count: file.inspected.pageCount,
              sha256: file.inspected.sha256,
              original_name: file.originalName,
            })
            .execute();
          written.push(key);
          await storage.put(key, file.buffer, file.inspected.mimeType);
        }
        await addEvent(trx, ctx, input.clientId, { upload_id: upload.id, action: 'uploaded' });
        const detail = await loadUpload(trx, upload.id);
        if (!detail) throw new Error('upload vanished');
        return detail;
      });
    } catch (err) {
      await Promise.all(written.map((key) => storage.delete(key).catch(() => undefined)));
      throw err;
    }
  }

  /**
   * 队列任务的发起人（规格 3.2）：只按 upload_id 查，只返回身份，不返回业务数据。
   * 只对排队中、识别中的记录有结果。
   */
  requester(uploadId: string): Promise<TenantContext | undefined> {
    return reportUploadRequester(this.db, uploadId);
  }

  /**
   * 认领一次识别，返回原件列表。任务带的 attempt 必须是记录当前这次识别：
   * 排队中的直接认领；识别中的（已被认领）只有超过 10 分钟没有进度（服务重启等）才能重新认领，
   * 同一次识别的重复任务读不到。
   */
  claimExtraction(
    ctx: TenantContext,
    uploadId: string,
    attempt: number,
  ): Promise<ClaimedExtraction | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return undefined;
      const upload = await trx
        .selectFrom('report_uploads')
        .select(['id', 'client_id', 'status', 'page_count'])
        .where('id', '=', uploadId)
        .where('manager_id', '=', ctx.userId)
        .where('attempts', '=', attempt)
        .where((eb) =>
          eb.or([
            eb('status', '=', 'queued'),
            eb.and([eb('status', '=', 'processing'), eb('updated_at', '<', claimStaleBefore())]),
          ]),
        )
        .forUpdate()
        .executeTakeFirst();
      if (!upload) return undefined;
      if (!(await ownClient(trx, ctx, upload.client_id))) return undefined;
      await trx
        .updateTable('report_uploads')
        .set({ status: 'processing', progress_page: 0, claimed_attempt: attempt })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action: 'extraction_started',
      });
      const files = await trx
        .selectFrom('report_files')
        .select(['storage_key', 'mime_type', 'page_count'])
        .where('upload_id', '=', uploadId)
        .orderBy('seq')
        .execute();
      return {
        pageCount: upload.page_count,
        files: files.map((f) => ({
          storageKey: f.storage_key,
          mimeType: f.mime_type,
          pageCount: f.page_count,
        })),
      };
    });
  }

  /** 更新进度。记录已不在识别中（被放弃、客户转出）时返回 false，调用方停止识别 */
  setProgress(ctx: TenantContext, uploadId: string, page: number): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const res = await trx
        .updateTable('report_uploads')
        .set({ progress_page: page })
        .where('id', '=', uploadId)
        .where('status', '=', 'processing')
        .where('manager_id', '=', ctx.userId)
        .executeTakeFirst();
      return res.numUpdatedRows > 0n;
    });
  }

  /**
   * 写回识别结果（规格 3.2）：先锁住记录，重新确认仍是识别中、客户仍归这位健管师，
   * 否则丢弃结果。和已有记录对比冲突、可能重复（Q17）。
   */
  finishExtraction(
    ctx: TenantContext,
    uploadId: string,
    result: ExtractionResult,
  ): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload || upload.status !== 'processing') return false;
      if (!(await ownClient(trx, ctx, upload.client_id))) return false;
      const items = result.items.map((i) => processItem(i));
      const existing = result.reportDate
        ? await sameDateValues(trx, upload.client_id, result.reportDate)
        : new Map<string, number[]>();
      const marked = markConflicts(items, existing);
      for (const [seq, item] of marked.entries()) {
        await trx
          .insertInto('extracted_values')
          .values({
            ...tenantScope(ctx),
            client_id: upload.client_id,
            upload_id: uploadId,
            seq,
            ...itemColumns(item),
            page: item.page,
            source_snippet: clip(item.snippet, LIMITS.snippet),
          })
          .execute();
      }
      await trx
        .updateTable('report_uploads')
        .set({
          status: 'needs_review',
          progress_page: upload.page_count,
          report_date: result.reportDate,
          institution: clip(result.institution, LIMITS.institution),
          version: upload.version + 1,
        })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action: 'extraction_done',
      });
      return true;
    });
  }

  /** 识别失败：只记原因类别，不留半成品数值 */
  failExtraction(
    ctx: TenantContext,
    uploadId: string,
    category: 'not_a_report' | 'unreadable' | 'refused' | 'timeout' | 'too_large' | 'error',
  ): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload || (upload.status !== 'processing' && upload.status !== 'queued')) return false;
      await trx
        .updateTable('report_uploads')
        .set({ status: 'failed', failure_category: category, progress_page: 0 })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action: 'extraction_failed',
      });
      return true;
    });
  }

  /**
   * 入队失败：记录改为失败（原因“出错”），并退还这次识别预占的页数（Q24）。
   * 退还由数据库函数检查：只退自己发起、还没被认领的这一次。
   */
  failEnqueue(ctx: TenantContext, uploadId: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload || upload.status !== 'queued') return false;
      await trx
        .updateTable('report_uploads')
        .set({ status: 'failed', failure_category: 'error', progress_page: 0 })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action: 'extraction_failed',
      });
      return reportQuotaRefund(trx, uploadId);
    });
  }

  getUpload(ctx: TenantContext, uploadId: string): Promise<ReportUpload | undefined> {
    return withTenant(this.db, ctx, (trx) => loadUpload(trx, uploadId));
  }

  uploadSummary(ctx: TenantContext, uploadId: string): Promise<ReportUploadSummary | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await selectUploadSummary(trx).where('u.id', '=', uploadId).executeTakeFirst();
      return row && toUploadSummary(row);
    });
  }

  /** 某位客户的识别记录（核对标签和角标用），新的在前 */
  listUploads(ctx: TenantContext, clientId: string): Promise<ReportUploadSummary[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId, false))) return undefined;
      const rows = await selectUploadSummary(trx)
        .where('u.client_id', '=', clientId)
        .orderBy('u.created_at', 'desc')
        .limit(UPLOAD_LIST_LIMIT)
        .execute();
      return rows.map(toUploadSummary);
    });
  }

  /** 重新识别（失败后，最多 3 次）。返回这是第几次 */
  retry(ctx: TenantContext, uploadId: string): Promise<{ upload: ReportUploadSummary }> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload) throw notFound();
      if (!(await ownClient(trx, ctx, upload.client_id))) throw notFound();
      if (upload.status !== 'failed') throw conflict({ reasons: ['not_retryable'] });
      if (upload.attempts >= REPORT_UPLOAD_LIMITS.maxAttempts) {
        throw conflict({ reasons: ['retry_limit'] });
      }
      await reservePages(trx, ctx, upload.page_count);
      await trx
        .updateTable('report_uploads')
        .set({
          status: 'queued',
          failure_category: null,
          attempts: upload.attempts + 1,
          requested_by: ctx.userId,
          progress_page: 0,
        })
        .where('id', '=', uploadId)
        .execute();
      const row = await selectUploadSummary(trx)
        .where('u.id', '=', uploadId)
        .executeTakeFirstOrThrow();
      return { upload: toUploadSummary(row) };
    });
  }

  /** 放弃：任何未核对的状态都可以；之后只读 */
  discard(ctx: TenantContext, uploadId: string): Promise<ReportUpload> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload) throw notFound();
      if (upload.status === 'verified' || upload.status === 'discarded') {
        throw conflict({ reasons: ['not_reviewable'] });
      }
      await trx
        .updateTable('report_uploads')
        .set({ status: 'discarded', failure_category: null })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, { upload_id: uploadId, action: 'discarded' });
      const detail = await loadUpload(trx, uploadId);
      if (!detail) throw notFound();
      return detail;
    });
  }

  /**
   * 修改一项、勾选“已核对”或删除识别错的行（规格 2.4）。每次修改记一条操作记录（不记数值），
   * 识别记录的版本号加一。修改了内容的行要重新勾选。
   */
  updateValue(
    ctx: TenantContext,
    uploadId: string,
    valueId: string,
    patch: UpdateExtractedValueRequest,
  ): Promise<{ value: ExtractedValue; version: number }> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await reviewableUpload(trx, ctx, uploadId);
      const row = await trx
        .selectFrom('extracted_values')
        .selectAll()
        .where('id', '=', valueId)
        .where('upload_id', '=', uploadId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.review_status === 'deleted') throw conflict({ reasons: ['deleted'] });

      const edits =
        patch.rawName !== undefined ||
        patch.code !== undefined ||
        patch.rawValue !== undefined ||
        patch.rawUnit !== undefined ||
        patch.refText !== undefined;
      let action: ReportEventAction;
      let set: Updateable<ExtractedValuesTable>;
      if (patch.deleted) {
        action = 'value_deleted';
        set = { review_status: 'deleted', checked_by: null };
      } else if (edits) {
        const code = patch.code === undefined ? row.code : patch.code;
        if (code !== null && !isCatalogCode(code)) throw badRequest();
        const item = processItem(
          {
            rawName: patch.rawName ?? row.raw_name,
            rawValue: patch.rawValue ?? row.raw_value,
            rawUnit: patch.rawUnit === undefined ? row.raw_unit : patch.rawUnit,
            refText: patch.refText === undefined ? row.ref_text : patch.refText,
            page: row.page,
            snippet: row.source_snippet,
            // 健管师改了数值，就不再是“看不清”
            unreadable: patch.rawValue === undefined && row.flags.includes('unreadable'),
          },
          code,
        );
        const [marked] = await recheckConflicts(trx, upload, item, valueId);
        action = 'value_edited';
        set = {
          ...itemColumns(marked ?? item),
          review_status: row.review_status === 'added' ? 'added' : 'edited',
          checked_by: patch.checked ? ctx.userId : null,
        };
      } else if (patch.checked !== undefined) {
        action = 'value_checked';
        set = { checked_by: patch.checked ? ctx.userId : null };
        if (patch.checked && row.review_status === 'pending') set.review_status = 'checked';
        if (!patch.checked && row.review_status === 'checked') set.review_status = 'pending';
      } else {
        throw badRequest();
      }
      const updated = await trx
        .updateTable('extracted_values')
        .set(set)
        .where('id', '=', valueId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const version = await bumpVersion(trx, uploadId, upload.version);
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action,
        extracted_value_id: valueId,
      });
      return { value: toExtractedValue(updated), version };
    });
  }

  /** 补录漏掉的一行 */
  addValue(
    ctx: TenantContext,
    uploadId: string,
    input: AddExtractedValueRequest,
  ): Promise<{ value: ExtractedValue; version: number }> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await reviewableUpload(trx, ctx, uploadId);
      const code = input.code;
      if (code !== undefined && code !== null && !isCatalogCode(code)) throw badRequest();
      if (input.page && input.page > upload.page_count) throw badRequest();
      const item = processItem(
        {
          rawName: input.rawName,
          rawValue: input.rawValue,
          rawUnit: input.rawUnit ?? null,
          refText: input.refText ?? null,
          page: input.page ?? null,
          snippet: null,
          unreadable: false,
        },
        code,
      );
      const [marked] = await recheckConflicts(trx, upload, item, null);
      const max = await trx
        .selectFrom('extracted_values')
        .select((eb) => eb.fn.max<number | null>('seq').as('seq'))
        .where('upload_id', '=', uploadId)
        .executeTakeFirst();
      const row = await trx
        .insertInto('extracted_values')
        .values({
          ...tenantScope(ctx),
          client_id: upload.client_id,
          upload_id: uploadId,
          seq: (max?.seq ?? -1) + 1,
          ...itemColumns(marked ?? item),
          page: item.page,
          source_snippet: null,
          review_status: 'added',
          checked_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const version = await bumpVersion(trx, uploadId, upload.version);
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        action: 'value_added',
        extracted_value_id: row.id,
      });
      return { value: toExtractedValue(row), version };
    });
  }

  /**
   * 确认核对（规格 2.4）：同一个事务里校验版本号、逐行勾选、同日报告和危急指标，
   * 写入正式的报告和指标表（来源 upload），识别记录变为只读。
   */
  verify(
    ctx: TenantContext,
    uploadId: string,
    input: Required<VerifyUploadRequest>,
  ): Promise<{ upload: ReportUpload; critical: CriticalFlag[] }> {
    return withTenant(this.db, ctx, async (trx) => {
      const upload = await lockUpload(trx, ctx, uploadId);
      if (!upload) throw notFound();
      if (!(await ownClient(trx, ctx, upload.client_id))) throw notFound();
      if (upload.status !== 'needs_review') throw verifyRejected({ reasons: ['not_reviewable'] });
      if (upload.version !== input.version) throw verifyRejected({ reasons: ['stale_version'] });

      const rows = (
        await trx
          .selectFrom('extracted_values')
          .selectAll()
          .where('upload_id', '=', uploadId)
          .orderBy('seq')
          .execute()
      ).filter((r) => r.review_status !== 'deleted');

      const reasons = new Set<VerifyRejection['reasons'][number]>();
      const valueIds = new Set<string>();
      if (!rows.length) reasons.add('no_values');
      const checked = new Set(input.checkedValueIds);
      for (const r of rows) {
        if (needsAttention(r.flags) && !checked.has(r.id)) {
          reasons.add('unchecked_attention');
          valueIds.add(r.id);
        }
        if (r.code !== null && (r.value === null || r.unit === null)) {
          reasons.add('missing_value');
          valueIds.add(r.id);
        }
      }
      const byCode = new Map<string, string[]>();
      for (const r of rows) {
        if (r.code) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r.id]);
      }
      for (const ids of byCode.values()) {
        if (ids.length > 1) {
          reasons.add('duplicate_code');
          ids.forEach((id) => valueIds.add(id));
        }
      }
      const sameDate = await trx
        .selectFrom('health_reports')
        .select('id')
        .where('client_id', '=', upload.client_id)
        .where('report_date', '=', asDate(input.reportDate))
        .execute();
      if (sameDate.length && !input.saveAsNew) reasons.add('same_date_report');

      // 危急指标只用已核对（就是现在要确认的）数值，按平台阈值识别（M1 第五节之二）
      const rules = await trx
        .selectFrom('critical_thresholds')
        .select(['metric', 'comparator', 'value', 'level', 'enabled'])
        .execute();
      const observations: Observation[] = rows
        .filter((r) => r.code !== null && r.value !== null && r.unit !== null)
        .map((r) => ({
          metric: r.code as string,
          value: Number(r.value),
          unit: r.unit as string,
          observedOn: input.reportDate,
          source: 'report',
        }));
      const critical = detectCriticalFlags(
        rules.map((r) => ({
          metric: r.metric as IndicatorCode,
          comparator: r.comparator,
          value: Number(r.value),
          level: r.level,
          enabled: r.enabled,
        })),
        observations,
      );
      if (critical.length && !input.acknowledgedCritical) reasons.add('critical_unacknowledged');

      if (reasons.size) {
        throw verifyRejected({
          reasons: [...reasons],
          ...(valueIds.size ? { valueIds: [...valueIds] } : {}),
          ...(critical.length ? { critical } : {}),
          ...(sameDate.length ? { sameDateReportIds: sameDate.map((r) => r.id) } : {}),
        });
      }

      const report = await trx
        .insertInto('health_reports')
        .values({
          ...tenantScope(ctx),
          client_id: upload.client_id,
          report_date: input.reportDate,
          title: 'upload',
          source: 'upload',
          upload_id: uploadId,
          institution: upload.institution,
          verified_by: ctx.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const r of rows) {
        const value = num(r.value);
        await trx
          .insertInto('report_indicators')
          .values({
            ...tenantScope(ctx),
            report_id: report.id,
            client_id: upload.client_id,
            code: r.code,
            value,
            unit: r.unit ?? r.raw_unit ?? '',
            raw_name: r.raw_name,
            original_value: r.raw_value || null,
            original_unit: r.raw_unit,
            ref_low: num(r.ref_low),
            ref_high: num(r.ref_high),
            ref_text: r.ref_text,
            abnormal: abnormalFromColumns(value, num(r.ref_low), num(r.ref_high), r.ref_text),
          })
          .execute();
      }
      await trx
        .updateTable('report_uploads')
        .set({
          status: 'verified',
          report_id: report.id,
          verified_by: ctx.userId,
          report_date: input.reportDate,
          critical_acknowledged: critical.length > 0,
          version: upload.version + 1,
        })
        .where('id', '=', uploadId)
        .execute();
      await addEvent(trx, ctx, upload.client_id, {
        upload_id: uploadId,
        report_id: report.id,
        action: 'verified',
      });
      const detail = await loadUpload(trx, uploadId);
      if (!detail) throw notFound();
      return { upload: detail, critical };
    });
  }

  /** 原件预览：只有服务该客户的健管师能读（行级安全）。每次查看记一条 file_viewed */
  openFile(
    ctx: TenantContext,
    fileId: string,
    page: number,
  ): Promise<{ storageKey: string; mimeType: ReportMimeType; pageCount: number } | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return undefined;
      const file = await trx
        .selectFrom('report_files')
        .select([
          'id',
          'client_id',
          'upload_id',
          'storage_key',
          'mime_type',
          'page_count',
          'purged_at',
        ])
        .where('id', '=', fileId)
        .executeTakeFirst();
      // 页码超出范围按不存在处理，不记查看
      if (!file || file.purged_at || page > file.page_count) return undefined;
      await addEvent(trx, ctx, file.client_id, {
        upload_id: file.upload_id,
        action: 'file_viewed',
        file_id: file.id,
      });
      return { storageKey: file.storage_key, mimeType: file.mime_type, pageCount: file.page_count };
    });
  }

  /** 已核对报告列表（健管师和本机构管理员可读） */
  listReports(ctx: TenantContext, clientId: string): Promise<ReportListItem[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const rows = await selectReportList(trx, clientId).limit(REPORT_LIST_LIMIT).execute();
      return rows.map((r) => ({
        id: r.id,
        reportDate: r.report_date,
        institution: r.institution,
        source: r.source,
        indicatorCount: Number(r.indicator_count),
        abnormalCount: Number(r.abnormal_count),
      }));
    });
  }

  /** 报告详情：当前值、更正历史；原件列表只给服务该客户的健管师 */
  getReport(ctx: TenantContext, reportId: string): Promise<Report | undefined> {
    return withTenant(this.db, ctx, (trx) => loadReport(trx, ctx, reportId));
  }

  /**
   * 更正一项已核对的指标（规格 2.4）：插入新的一行，旧行指向新行，旧值保留可追溯。
   */
  correctIndicator(
    ctx: TenantContext,
    reportId: string,
    indicatorId: string,
    input: CorrectIndicatorRequest,
  ): Promise<Report> {
    return withTenant(this.db, ctx, async (trx) => {
      const report = await trx
        .selectFrom('health_reports')
        .select(['id', 'client_id', 'upload_id'])
        .where('id', '=', reportId)
        .executeTakeFirst();
      if (!report) throw notFound();
      if (!(await ownClient(trx, ctx, report.client_id))) throw notFound();
      const old = await trx
        .selectFrom('report_indicators')
        .selectAll()
        .where('id', '=', indicatorId)
        .where('report_id', '=', reportId)
        .forUpdate()
        .executeTakeFirst();
      if (!old) throw notFound();
      if (old.superseded_by) throw conflict({ reasons: ['superseded'] });
      if (old.code !== null && !isCatalogCode(old.code)) throw conflict();
      const item = processItem(
        {
          rawName: old.raw_name ?? old.code ?? '',
          rawValue: input.rawValue,
          rawUnit: input.rawUnit === undefined ? old.original_unit : input.rawUnit,
          refText: input.refText === undefined ? old.ref_text : input.refText,
          page: null,
          snippet: null,
          unreadable: false,
        },
        old.code,
      );
      // 目录指标更正后必须是认得的数值和单位
      if (item.code !== null && (item.value === null || item.unit === null)) throw badRequest();
      const newId = crypto.randomUUID();
      // 先让旧行指向新行（外键延迟到提交时检查），再插入新行，保证“同一指标只有一个当前值”
      await trx
        .updateTable('report_indicators')
        .set({ superseded_by: newId })
        .where('id', '=', old.id)
        .execute();
      await trx
        .insertInto('report_indicators')
        .values({
          ...tenantScope(ctx),
          id: newId,
          report_id: reportId,
          client_id: report.client_id,
          code: old.code,
          value: item.value,
          unit: item.unit ?? item.rawUnit ?? '',
          raw_name: old.raw_name,
          original_value: item.rawValue,
          original_unit: item.rawUnit,
          ref_low: item.refLow,
          ref_high: item.refHigh,
          ref_text: clip(item.refText, LIMITS.ref),
          abnormal: abnormalFromColumns(item.value, item.refLow, item.refHigh, item.refText),
        })
        .execute();
      await addEvent(trx, ctx, report.client_id, {
        upload_id: report.upload_id,
        report_id: reportId,
        indicator_id: old.id,
        action: 'corrected',
      });
      const detail = await loadReport(trx, ctx, reportId);
      if (!detail) throw notFound();
      return detail;
    });
  }

  /** 某指标的历次数值（只含已核对报告的当前值） */
  trend(
    ctx: TenantContext,
    clientId: string,
    code: string,
  ): Promise<IndicatorTrendResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('report_indicators as i')
        .innerJoin('health_reports as r', (join) =>
          join.onRef('r.id', '=', 'i.report_id').onRef('r.client_id', '=', 'i.client_id'),
        )
        .select((eb) => [
          'r.id as report_id',
          'r.source',
          isoDate(eb, 'r.report_date').as('report_date'),
          'i.value',
          'i.unit',
          'i.original_value',
          'i.original_unit',
          'i.ref_low',
          'i.ref_high',
          'i.ref_text',
          'i.abnormal',
        ])
        .where('i.client_id', '=', clientId)
        .where('i.code', '=', code)
        .where('i.superseded_by', 'is', null)
        .where('i.value', 'is not', null)
        .orderBy('r.report_date', 'desc')
        .orderBy('r.created_at', 'desc')
        .limit(TREND_LIMIT)
        .execute();
      return {
        code,
        points: rows.map((r) => ({
          reportId: r.report_id,
          reportDate: r.report_date,
          source: r.source,
          value: Number(r.value),
          unit: r.unit,
          originalValue: r.original_value,
          originalUnit: r.original_unit,
          refLow: num(r.ref_low),
          refHigh: num(r.ref_high),
          refText: r.ref_text,
          abnormal: r.abnormal,
        })),
      };
    });
  }

  /** 客户删除后待清除的原件（Q6）。以所有者函数取用，不需要租户上下文 */
  async purgeBatch(storage: ObjectStorage, limit = 50): Promise<number> {
    const keys = await storagePurgeClaim(this.db, limit);
    const done: string[] = [];
    for (const key of keys) {
      try {
        await storage.delete(key);
        done.push(key);
      } catch {
        // 下次再试
      }
    }
    await storagePurgeDone(this.db, done);
    return done.length;
  }
}

/** 识别记录的租户上下文写入工具 */
async function addEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
  event: {
    upload_id: string | null;
    report_id?: string;
    action: ReportEventAction;
    extracted_value_id?: string;
    indicator_id?: string;
    file_id?: string;
  },
): Promise<void> {
  await trx
    .insertInto('report_events')
    .values({ ...tenantScope(ctx), client_id: clientId, actor_id: ctx.userId, ...event })
    .execute();
}

/**
 * 当天的识别页数加上 pages（Q24）。一条 upsert 原子地累加，上限写在数据库约束里：
 * 超过每天 200 页时约束失败，整个事务回滚，返回 429。
 */
async function reservePages(trx: TenantTransaction, ctx: TenantContext, pages: number) {
  if (pages > REPORT_UPLOAD_LIMITS.dailyPages) throw tooManyRequests(['daily_page_limit']);
  try {
    await trx
      .insertInto('report_extraction_quota')
      .values({
        manager_id: ctx.userId,
        operator_id: ctx.operatorId ?? '',
        day: currentDate(),
        pages,
      })
      .onConflict((oc) =>
        oc.columns(['manager_id', 'day']).doUpdateSet((eb) => ({
          pages: eb('report_extraction_quota.pages', '+', eb.ref('excluded.pages')),
        })),
      )
      .execute();
  } catch (err) {
    if (dbErrorCode(err) === '23514') throw tooManyRequests(['daily_page_limit']);
    throw err;
  }
}

async function lockUpload(trx: TenantTransaction, ctx: TenantContext, uploadId: string) {
  if (ctx.role !== 'manager') return undefined;
  return trx
    .selectFrom('report_uploads')
    .select([
      'id',
      'client_id',
      'status',
      'version',
      'attempts',
      'page_count',
      'institution',
      (eb) =>
        eb
          .fn<string | null>('to_char', [eb.ref('report_date'), eb.val('YYYY-MM-DD')])
          .as('report_date'),
    ])
    .where('id', '=', uploadId)
    .forUpdate()
    .executeTakeFirst();
}

type LockedUpload = NonNullable<Awaited<ReturnType<typeof lockUpload>>>;

/** 待核对、属于自己的识别记录；否则 404 或 409 */
async function reviewableUpload(
  trx: TenantTransaction,
  ctx: TenantContext,
  uploadId: string,
): Promise<LockedUpload> {
  const upload = await lockUpload(trx, ctx, uploadId);
  if (!upload) throw notFound();
  if (!(await ownClient(trx, ctx, upload.client_id))) throw notFound();
  if (upload.status !== 'needs_review') throw conflict({ reasons: ['not_reviewable'] });
  return upload;
}

async function bumpVersion(trx: TenantTransaction, uploadId: string, current: number) {
  await trx
    .updateTable('report_uploads')
    .set({ version: current + 1 })
    .where('id', '=', uploadId)
    .execute();
  return current + 1;
}

function itemColumns(item: ProcessedItem) {
  return {
    raw_name: clip(item.rawName, LIMITS.name) ?? '?',
    code: item.code,
    raw_value: clip(item.rawValue, LIMITS.value) ?? '',
    raw_unit: clip(item.rawUnit, LIMITS.unit),
    value: item.value,
    unit: clip(item.unit, LIMITS.unit),
    ref_low: item.refLow,
    ref_high: item.refHigh,
    ref_text: clip(item.refText, LIMITS.ref),
    flags: item.flags,
  };
}

/** 同一报告日期已有的正式报告里，各指标的当前值 */
async function sameDateValues(
  trx: TenantTransaction,
  clientId: string,
  reportDate: string,
): Promise<Map<string, number[]>> {
  const rows = await trx
    .selectFrom('report_indicators as i')
    .innerJoin('health_reports as r', 'r.id', 'i.report_id')
    .select(['i.code', 'i.value'])
    .where('r.client_id', '=', clientId)
    .where('r.report_date', '=', asDate(reportDate))
    .where('i.superseded_by', 'is', null)
    .where('i.code', 'is not', null)
    .execute();
  const map = new Map<string, number[]>();
  for (const r of rows) {
    if (r.code === null || r.value === null) continue;
    map.set(r.code, [...(map.get(r.code) ?? []), Number(r.value)]);
  }
  return map;
}

/** 修改或补录一行后，重新和同日报告、本次上传的其他行对比冲突 */
async function recheckConflicts(
  trx: TenantTransaction,
  upload: LockedUpload,
  item: ProcessedItem,
  valueId: string | null,
): Promise<ProcessedItem[]> {
  const existing = upload.report_date
    ? await sameDateValues(trx, upload.client_id, upload.report_date)
    : new Map<string, number[]>();
  if (item.code) {
    const siblings = await trx
      .selectFrom('extracted_values')
      .select('id')
      .where('upload_id', '=', upload.id)
      .where('code', '=', item.code)
      .where('review_status', '<>', 'deleted')
      .execute();
    if (siblings.some((s) => s.id !== valueId)) {
      return [{ ...item, flags: [...new Set<ExtractedValueFlag>([...item.flags, 'conflict'])] }];
    }
  }
  return markConflicts([item], existing);
}

async function loadUpload(
  trx: TenantTransaction,
  uploadId: string,
): Promise<ReportUpload | undefined> {
  const upload = await trx
    .selectFrom('report_uploads as u')
    .select([
      ...uploadSummaryColumns,
      'u.version',
      'u.institution',
      'u.critical_acknowledged',
      (eb) =>
        eb
          .fn<string | null>('to_char', [eb.ref('u.report_date'), eb.val('YYYY-MM-DD')])
          .as('report_date'),
    ])
    .where('u.id', '=', uploadId)
    .executeTakeFirst();
  if (!upload) return undefined;
  const files = await trx
    .selectFrom('report_files')
    .select(['id', 'seq', 'mime_type', 'size_bytes', 'page_count', 'original_name'])
    .where('upload_id', '=', uploadId)
    .orderBy('seq')
    .execute();
  const values = await trx
    .selectFrom('extracted_values')
    .selectAll()
    .where('upload_id', '=', uploadId)
    .orderBy('seq')
    .execute();
  const sameDate =
    upload.report_date && upload.status !== 'verified'
      ? await trx
          .selectFrom('health_reports')
          .select('id')
          .where('client_id', '=', upload.client_id)
          .where('report_date', '=', asDate(upload.report_date))
          .execute()
      : [];
  return {
    ...toUploadSummary(upload),
    version: upload.version,
    reportDate: upload.report_date,
    institution: upload.institution,
    criticalAcknowledged: upload.critical_acknowledged,
    files: files.map((f) => ({
      id: f.id,
      seq: f.seq,
      mimeType: f.mime_type,
      sizeBytes: f.size_bytes,
      pageCount: f.page_count,
      originalName: f.original_name,
    })),
    values: values.map(toExtractedValue),
    sameDateReportIds: sameDate.map((r) => r.id),
  };
}

/** 已核对报告的摘要：当前指标数和高低异常数（按报告上印的参考范围，Q10） */
export function selectReportList(trx: TenantTransaction, clientId: string) {
  return trx
    .selectFrom('health_reports as r')
    .select((eb) => [
      'r.id',
      'r.source',
      'r.institution',
      isoDate(eb, 'r.report_date').as('report_date'),
      eb
        .selectFrom('report_indicators as i')
        .select((e) => e.fn.countAll<string>().as('n'))
        .whereRef('i.report_id', '=', 'r.id')
        .where('i.superseded_by', 'is', null)
        .as('indicator_count'),
      eb
        .selectFrom('report_indicators as i')
        .select((e) => e.fn.countAll<string>().as('n'))
        .whereRef('i.report_id', '=', 'r.id')
        .where('i.superseded_by', 'is', null)
        .where('i.abnormal', 'in', ['high', 'low'])
        .as('abnormal_count'),
    ])
    .where('r.client_id', '=', clientId)
    .orderBy('r.report_date', 'desc')
    .orderBy('r.created_at', 'desc');
}

async function loadReport(
  trx: TenantTransaction,
  ctx: TenantContext,
  reportId: string,
): Promise<Report | undefined> {
  const report = await trx
    .selectFrom('health_reports as r')
    .select((eb) => [
      'r.id',
      'r.client_id',
      'r.source',
      'r.institution',
      'r.verified_at',
      'r.upload_id',
      isoDate(eb, 'r.report_date').as('report_date'),
    ])
    .where('r.id', '=', reportId)
    .executeTakeFirst();
  if (!report) return undefined;
  const indicators = await trx
    .selectFrom('report_indicators')
    .selectAll()
    .where('report_id', '=', reportId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  // 原件只给服务该客户的健管师（机构管理员行级安全本来就读不到，这里不查）
  const files =
    ctx.role === 'manager' && report.upload_id
      ? await trx
          .selectFrom('report_files')
          .select(['id', 'seq', 'mime_type', 'page_count'])
          .where('upload_id', '=', report.upload_id)
          .where('purged_at', 'is', null)
          .orderBy('seq')
          .execute()
      : [];
  return {
    id: report.id,
    clientId: report.client_id,
    reportDate: report.report_date,
    institution: report.institution,
    source: report.source,
    verifiedAt: report.verified_at?.toISOString() ?? null,
    indicators: indicators.filter((i) => !i.superseded_by).map(toIndicator),
    corrections: indicators.filter((i) => i.superseded_by).map(toIndicator),
    files: files.map((f) => ({
      id: f.id,
      seq: f.seq,
      mimeType: f.mime_type,
      pageCount: f.page_count,
    })),
  };
}

async function clientVisible(trx: TenantTransaction, clientId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .executeTakeFirst();
  return Boolean(row);
}

/** 只有服务这位客户的健管师能写。锁住客户行，和并发的转出串行 */
async function ownClient(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
  lock = true,
): Promise<boolean> {
  if (ctx.role !== 'manager') return false;
  const q = trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', clientId)
    .where('manager_id', '=', ctx.userId);
  const row = await (lock ? q.forShare() : q).executeTakeFirst();
  return Boolean(row);
}
