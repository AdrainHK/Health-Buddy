import { apiErrorSchema, type ApiErrorCode } from '@health-buddy/shared';
import { z } from 'zod';

/**
 * 接口错误。code 是服务端返回的错误码；network 表示请求根本没发出去或没收到响应。
 * reasons 是服务端附带的结构化原因（如 409 的 busy、read_only），只含枚举值。
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network',
    readonly status: number,
    readonly reasons: readonly string[] = [],
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

// 错误体是 { error, ...details }；这里只取错误码和枚举原因，其余细节由具体接口自己解析
const errorBodySchema = apiErrorSchema.extend({ reasons: z.array(z.string()).optional() });

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 发出请求，返回原始响应。网络失败转成 ApiError('network')，主动取消时原样抛出 AbortError。 */
export async function apiFetch(
  path: string,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<Response> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body instanceof FormData) {
    // 上传文件：浏览器自己设置 multipart 的 Content-Type 和分隔符
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  try {
    return await fetch(`/api${path}`, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError('network', 0);
  }
}

/** 把非 2xx 响应转成 ApiError。body 是已经读出来的响应体（需要解析其他细节时） */
export async function toApiError(res: Response, body?: unknown): Promise<ApiError> {
  const json = body === undefined ? await res.json().catch(() => null) : body;
  const parsed = errorBodySchema.safeParse(json);
  if (!parsed.success) return new ApiError('internal_error', res.status);
  return new ApiError(parsed.data.error, res.status, parsed.data.reasons ?? []);
}

/** 调用后端接口。和后端同源，Cookie 自动带上。 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T> | null,
  options: RequestOptions = {},
): Promise<T> {
  const res = await apiFetch(path, options);
  if (!res.ok) throw await toApiError(res);
  if (schema === null || res.status === 204) return undefined as T;
  return schema.parse(await res.json());
}
