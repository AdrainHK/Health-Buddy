import {
  duplicateFileRejectionSchema,
  extractedValueResponseSchema,
  indicatorTrendResponseSchema,
  reportListResponseSchema,
  reportResponseSchema,
  reportUploadListResponseSchema,
  reportUploadResponseSchema,
  reportUploadStreamEventSchema,
  verifyRejectionSchema,
  verifyUploadResponseSchema,
  type CriticalFlag,
  type AddExtractedValueRequest,
  type DuplicateUpload,
  type CorrectIndicatorRequest,
  type ExtractedValueResponse,
  type IndicatorTrendResponse,
  type Report,
  type ReportListItem,
  type ReportUpload,
  type ReportUploadStreamEvent,
  type ReportUploadSummary,
  type UpdateExtractedValueRequest,
  type VerifyRejection,
  type VerifyUploadRequest,
} from '@health-buddy/shared';
import { ApiError, apiFetch, apiRequest, toApiError } from './http';
import { SseParser } from './stream';

/**
 * 报告上传、识别和核对（M2 规格 2.3、2.4、2.6）。
 * 原件只通过后端接口查看（不缓存）；识别记录、原件和待核对结果只有服务该客户的健管师能看。
 */

/** 上传一份报告（可以多个文件、多页）。在对话里上传时带上任务 id */
export async function uploadReport(
  clientId: string,
  files: readonly File[],
  taskId?: string | null,
): Promise<ReportUpload> {
  const form = new FormData();
  if (taskId) form.append('taskId', taskId);
  for (const file of files) form.append('files', file, file.name || 'file');
  const res = await apiFetch(`/clients/${clientId}/report-uploads`, {
    method: 'POST',
    body: form,
  });
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 409) {
    const duplicate = duplicateFileRejectionSchema.safeParse(json);
    if (duplicate.success) throw new DuplicateFileError(duplicate.data.existing);
  }
  if (!res.ok) throw await toApiError(res, json);
  return reportUploadResponseSchema.parse(json).upload;
}

/**
 * 同一个文件已经上传过（409 duplicate_file）。existing 是已有的那一份识别记录
 * （一次上传里放了两个相同文件时为 null），对话里据此引用报告或去核对（验收反馈 6）。
 */
export class DuplicateFileError extends ApiError {
  constructor(readonly existing: DuplicateUpload | null) {
    super('conflict', 409, ['duplicate_file']);
    this.name = 'DuplicateFileError';
  }
}

export async function listUploads(
  clientId: string,
  signal?: AbortSignal,
): Promise<ReportUploadSummary[]> {
  const { uploads } = await apiRequest(
    `/clients/${clientId}/report-uploads`,
    reportUploadListResponseSchema,
    signal ? { signal } : {},
  );
  return uploads;
}

export async function getUpload(id: string, signal?: AbortSignal): Promise<ReportUpload> {
  const { upload } = await apiRequest(
    `/report-uploads/${id}`,
    reportUploadResponseSchema,
    signal ? { signal } : {},
  );
  return upload;
}

/**
 * 订阅识别进度（GET SSE）。收到 done 或流结束时返回最后一次的状态；
 * 连接断开时抛出 ApiError('network')，调用方可以重新订阅。
 */
export async function watchUpload(
  id: string,
  onEvent: (event: ReportUploadStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(`/report-uploads/${id}/events`, signal ? { signal } : {});
  if (!res.ok) throw await toApiError(res);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const emit = (payloads: string[]) => {
    for (const data of payloads) {
      try {
        const parsed = reportUploadStreamEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // 不认识的事件丢掉
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
    emit(parser.push(decoder.decode()));
    emit(parser.flush());
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError('network', 0);
  } finally {
    reader.releaseLock();
  }
}

export async function retryUpload(id: string): Promise<ReportUpload> {
  const { upload } = await apiRequest(`/report-uploads/${id}/retry`, reportUploadResponseSchema, {
    method: 'POST',
  });
  return upload;
}

export async function discardUpload(id: string): Promise<ReportUpload> {
  const { upload } = await apiRequest(`/report-uploads/${id}/discard`, reportUploadResponseSchema, {
    method: 'POST',
  });
  return upload;
}

export function updateValue(
  uploadId: string,
  valueId: string,
  body: UpdateExtractedValueRequest,
): Promise<ExtractedValueResponse> {
  return apiRequest(`/report-uploads/${uploadId}/values/${valueId}`, extractedValueResponseSchema, {
    method: 'PATCH',
    body,
  });
}

export function addValue(
  uploadId: string,
  body: AddExtractedValueRequest,
): Promise<ExtractedValueResponse> {
  return apiRequest(`/report-uploads/${uploadId}/values`, extractedValueResponseSchema, {
    method: 'POST',
    body,
  });
}

/** 确认核对被拒绝（409）：带上原因、涉及的行和命中的危急指标 */
export class VerifyRejectedError extends Error {
  constructor(readonly rejection: VerifyRejection) {
    super('verify_rejected');
    this.name = 'VerifyRejectedError';
  }
}

/** 确认核对；成功时带上命中的危急指标（没有命中为空数组） */
export async function verifyUpload(
  id: string,
  body: VerifyUploadRequest,
): Promise<{ upload: ReportUpload; critical: CriticalFlag[] }> {
  const res = await apiFetch(`/report-uploads/${id}/verify`, { method: 'POST', body });
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 409) {
    const rejection = verifyRejectionSchema.safeParse(json);
    if (rejection.success) throw new VerifyRejectedError(rejection.data);
  }
  if (!res.ok) throw await toApiError(res, json);
  const parsed = verifyUploadResponseSchema.parse(json);
  return { upload: parsed.upload, critical: parsed.critical ?? [] };
}

/** 原件某一页的地址（后端转发，不缓存） */
export function fileContentUrl(fileId: string, page = 1): string {
  return `/api/report-files/${fileId}/content?page=${page}`;
}

export async function listReports(
  clientId: string,
  signal?: AbortSignal,
): Promise<ReportListItem[]> {
  const { reports } = await apiRequest(
    `/clients/${clientId}/reports`,
    reportListResponseSchema,
    signal ? { signal } : {},
  );
  return reports;
}

export async function getReport(id: string, signal?: AbortSignal): Promise<Report> {
  const { report } = await apiRequest(
    `/reports/${id}`,
    reportResponseSchema,
    signal ? { signal } : {},
  );
  return report;
}

export async function correctIndicator(
  reportId: string,
  indicatorId: string,
  body: CorrectIndicatorRequest,
): Promise<Report> {
  const { report } = await apiRequest(
    `/reports/${reportId}/indicators/${indicatorId}/correct`,
    reportResponseSchema,
    { method: 'POST', body },
  );
  return report;
}

export function getTrend(
  clientId: string,
  code: string,
  signal?: AbortSignal,
): Promise<IndicatorTrendResponse> {
  return apiRequest(
    `/clients/${clientId}/indicators/${code}/trend`,
    indicatorTrendResponseSchema,
    signal ? { signal } : {},
  );
}

/** 浏览器选择文件时的 accept：只是提示，后端按文件内容判断 */
export const REPORT_ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic,.heic,.heif';

/** 识别中（还会变化）的状态 */
export function isActive(status: ReportUploadSummary['status']): boolean {
  return status === 'queued' || status === 'processing';
}
