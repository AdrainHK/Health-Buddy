import {
  apiErrorSchema,
  brandResponseSchema,
  type Brand,
  type UpdateBrandRequest,
} from '@health-buddy/shared';
import { ApiError, apiRequest } from './http';

/** 协会品牌（M7 规格 2.2）：只有运营商管理员读写本协会的 */
export async function getBrand(): Promise<Brand> {
  return (await apiRequest('/admin/brand', brandResponseSchema)).brand;
}

export async function saveBrand(body: UpdateBrandRequest): Promise<Brand> {
  return (await apiRequest('/admin/brand', brandResponseSchema, { method: 'PUT', body })).brand;
}

/** 上传 Logo（multipart，字段名 file）。错误和 apiRequest 一样抛 ApiError */
export async function uploadBrandLogo(file: File): Promise<Brand> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch('/api/admin/brand/logo', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('network', 0);
  }
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    const details = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    throw new ApiError(parsed.success ? parsed.data.error : 'internal_error', res.status, details);
  }
  return brandResponseSchema.parse(await res.json()).brand;
}
