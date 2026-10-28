import { apiErrorSchema, type ApiErrorCode } from '@health-buddy/shared';
import type { z } from 'zod';

/**
 * 接口错误。code 是服务端返回的错误码；network 表示请求根本没发出去或没收到响应。
 * 后台只需要错误码，比工作台的版本精简。
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network',
    readonly status: number,
    /** 响应体里错误码以外的结构化细节（如方案库内容检查标出的位置），只有枚举值和位置 */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
}

let onUnauthenticated: (() => void) | null = null;

/** 登录状态由 AuthProvider 管；会话中途过期（非 /auth 接口返回 401）时通知它回到登录页。 */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/** 调用后端接口。和后端同源（后台挂在同一个后端的 /admin/ 下），Cookie 自动带上。 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T> | null,
  { method = 'GET', body }: RequestOptions = {},
): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError('network', 0);
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthenticated?.();
    const raw: unknown = await res.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    const details = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    throw new ApiError(parsed.success ? parsed.data.error : 'internal_error', res.status, details);
  }
  if (schema === null || res.status === 204) return undefined as T;
  return schema.parse(await res.json());
}
