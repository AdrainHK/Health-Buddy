import {
  apiErrorSchema,
  approveRejectionSchema,
  artifactDetailResponseSchema,
  clientTextResponseSchema,
  type ApproveArtifactRequest,
  type ApproveRejection,
  type ArtifactDetailResponse,
  type ExportFormat,
  type UpdateArtifactRequest,
} from '@health-buddy/shared';
import { ApiError, apiFetch, apiRequest, toApiError } from './http';
import { streamRequest, type StreamOptions } from './stream';

/**
 * 确认被拒绝（409）。除了原因，还带禁用词、危急指标数值和风险分层字样在通俗版里的位置，
 * 前端据此标出问题。
 */
export class ApproveRejectedError extends ApiError {
  readonly bannedTerms: NonNullable<ApproveRejection['bannedTerms']>;
  readonly criticalValueMentions: NonNullable<ApproveRejection['criticalValueMentions']>;
  readonly riskTierMentions: NonNullable<ApproveRejection['riskTierMentions']>;

  constructor(rejection: ApproveRejection) {
    super('conflict', 409, rejection.reasons);
    this.bannedTerms = rejection.bannedTerms ?? [];
    this.criticalValueMentions = rejection.criticalValueMentions ?? [];
    this.riskTierMentions = rejection.riskTierMentions ?? [];
  }
}

/** 产物详情：内容、指纹、提示、版本和记录 */
export function getArtifact(id: string, signal?: AbortSignal): Promise<ArtifactDetailResponse> {
  return apiRequest(`/artifacts/${id}`, artifactDetailResponseSchema, signal ? { signal } : {});
}

/** 修改草稿（只能改最新草稿，带版本号和内容指纹） */
export function updateArtifact(
  id: string,
  body: UpdateArtifactRequest,
): Promise<ArtifactDetailResponse> {
  return apiRequest(`/artifacts/${id}`, artifactDetailResponseSchema, { method: 'PATCH', body });
}

/** 确认。409 时抛出 ApproveRejectedError（带位置），其余错误抛 ApiError。 */
export async function approveArtifact(
  id: string,
  body: ApproveArtifactRequest,
): Promise<ArtifactDetailResponse> {
  const res = await apiFetch(`/artifacts/${id}/approve`, { method: 'POST', body });
  if (res.ok) return artifactDetailResponseSchema.parse(await res.json());
  if (res.status !== 409) throw await toApiError(res);
  const raw: unknown = await res.json().catch(() => null);
  const rejection = approveRejectionSchema.safeParse(raw);
  if (rejection.success) throw new ApproveRejectedError(rejection.data);
  const generic = apiErrorSchema.safeParse(raw);
  throw new ApiError(generic.success ? generic.data.error : 'conflict', 409);
}

/** 基于已审核版本新建草稿，返回新草稿的详情 */
export function reviseArtifact(id: string): Promise<ArtifactDetailResponse> {
  return apiRequest(`/artifacts/${id}/revise`, artifactDetailResponseSchema, { method: 'POST' });
}

/** 退回重写：SSE，推送新版本的生成过程 */
export function returnArtifact(
  id: string,
  reason: string,
  options: Omit<StreamOptions, 'body'>,
): Promise<void> {
  return streamRequest(`/artifacts/${id}/return`, { ...options, body: { reason } });
}

/** 取已审核产物的通俗版文本（后端拼好免责声明和产品名称，并记复制记录） */
export async function copyArtifactText(id: string): Promise<string> {
  const { text } = await apiRequest(`/artifacts/${id}/copy`, clientTextResponseSchema, {
    method: 'POST',
  });
  return text;
}

export interface ExportedFile {
  blob: Blob;
  filename: string;
}

/** 导出已审核产物的通俗版图片或 PDF */
export async function exportArtifact(id: string, format: ExportFormat): Promise<ExportedFile> {
  const res = await apiFetch(`/artifacts/${id}/export`, { method: 'POST', body: { format } });
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  return {
    blob,
    filename: filenameFromDisposition(res.headers.get('Content-Disposition'), format),
  };
}

/**
 * 从 Content-Disposition 取文件名：优先 filename*（RFC 5987，UTF-8 百分号编码），
 * 其次 filename，都没有时用默认名。去掉路径分隔符，避免奇怪的文件名。
 */
export function filenameFromDisposition(header: string | null, format: ExportFormat): string {
  const fallback = `export.${format}`;
  if (!header) return fallback;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  let name: string | undefined;
  if (extended?.[2]) {
    try {
      name = decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
    name = (plain?.[1] ?? plain?.[2])?.trim();
  }
  const safe = name?.replace(/[/\\]/g, '_').trim();
  return safe ? safe : fallback;
}

/** 用 blob 触发浏览器下载 */
export function downloadBlob({ blob, filename }: ExportedFile): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 下一轮事件循环再释放，部分浏览器在 click 返回后才开始下载
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
