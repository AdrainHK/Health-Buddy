import { publicBrandResponseSchema, type PublicBrand } from '@health-buddy/shared';
import { apiRequest } from './http';

/** 登录页品牌（M7 规格 2.3，Q4）：未登录可读，只有公开字段 */
export async function fetchPublicBrand(slug: string): Promise<PublicBrand> {
  return (
    await apiRequest(`/public/brand?slug=${encodeURIComponent(slug)}`, publicBrandResponseSchema)
  ).brand;
}
