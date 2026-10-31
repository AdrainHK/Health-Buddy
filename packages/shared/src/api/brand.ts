import { z } from 'zod';
import { brandColorContrastOk, isHexColor } from '../brand-color.js';
import { findBannedTerms } from '../compliance/index.js';

/**
 * 协会品牌（M7 规格 2.2、2.3）：显示名称、Logo、主色、登录页欢迎语。
 * 只有运营商管理员改本协会的（Q16 平台不代改）；登录页按地址里的协会简称读公开字段（Q4）。
 * 客户能看到的地方暂不显示协会品牌（Q11）。
 */

export const BRAND_NAME_MAX = 20;
export const BRAND_GREETING_MAX = 60;
export const BRAND_LOGO_MAX_BYTES = 500 * 1024;
export const BRAND_LOGO_TYPES = ['image/png', 'image/svg+xml'] as const;
export type BrandLogoType = (typeof BRAND_LOGO_TYPES)[number];

const noBannedTerms = (v: string | null) => v === null || findBannedTerms(v).length === 0;

/** 保存品牌。空字符串当作不设置（显示协会名称、默认欢迎语） */
export const updateBrandRequestSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .max(BRAND_NAME_MAX)
      .transform((v) => v || null)
      .nullable(),
    primaryColor: z
      .string()
      .refine(isHexColor)
      .transform((v) => v.toLowerCase())
      .nullable(),
    loginGreeting: z
      .string()
      .trim()
      .max(BRAND_GREETING_MAX)
      .transform((v) => v || null)
      .nullable(),
  })
  .strict();
export type UpdateBrandRequest = z.infer<typeof updateBrandRequestSchema>;

/** 品牌内容问题：含禁用词（红线 5）、主色对比度不够（规格 2.2） */
export type BrandContentIssue =
  | { field: 'displayName' | 'loginGreeting'; reason: 'banned_term' }
  | { field: 'primaryColor'; reason: 'low_contrast' };

export function brandContentIssues(v: UpdateBrandRequest): BrandContentIssue[] {
  const issues: BrandContentIssue[] = [];
  if (!noBannedTerms(v.displayName)) issues.push({ field: 'displayName', reason: 'banned_term' });
  if (!noBannedTerms(v.loginGreeting)) {
    issues.push({ field: 'loginGreeting', reason: 'banned_term' });
  }
  if (v.primaryColor !== null && !brandColorContrastOk(v.primaryColor)) {
    issues.push({ field: 'primaryColor', reason: 'low_contrast' });
  }
  return issues;
}

export const brandSchema = z.object({
  /** 协会名称（运营商的正式名称，平台开通时填的） */
  operatorName: z.string(),
  displayName: z.string().nullable(),
  primaryColor: z.string().nullable(),
  loginGreeting: z.string().nullable(),
  /** Logo 地址（同源，带版本号）；没有 Logo 时为 null */
  logoUrl: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type Brand = z.infer<typeof brandSchema>;
export const brandResponseSchema = z.object({ brand: brandSchema });
export type BrandResponse = z.infer<typeof brandResponseSchema>;

/** 登录页品牌（未登录可读）：只有公开字段，不含协会 id */
export const publicBrandSchema = z.object({
  name: z.string(),
  primaryColor: z.string().nullable(),
  loginGreeting: z.string().nullable(),
  logoUrl: z.string().nullable(),
});
export type PublicBrand = z.infer<typeof publicBrandSchema>;
export const publicBrandResponseSchema = z.object({ brand: publicBrandSchema });
export type PublicBrandResponse = z.infer<typeof publicBrandResponseSchema>;

/** Logo 地址：按协会简称取，带更新时间做缓存版本 */
export function brandLogoPath(slug: string, updatedAt: Date | string): string {
  const v = typeof updatedAt === 'string' ? Date.parse(updatedAt) : updatedAt.getTime();
  return `/api/public/brand/logo/${encodeURIComponent(slug)}?v=${v}`;
}
