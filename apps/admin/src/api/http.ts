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
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
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
    const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
    throw new ApiError(parsed.success ? parsed.data.error : 'internal_error', res.status);
  }
  if (schema === null || res.status === 204) return undefined as T;
  return schema.parse(await res.json());
}
