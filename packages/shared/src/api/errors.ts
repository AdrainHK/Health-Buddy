import { z } from 'zod';

/**
 * 接口错误只返回错误码，界面文案由前端按语言翻译。
 * 跨租户访问一律返回 not_found，不提示“无权限”。
 */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthenticated',
  'invalid_credentials',
  'forbidden_origin',
  'not_found',
  'conflict',
  'too_many_requests',
  'internal_error',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: apiErrorCodeSchema });
export type ApiError = z.infer<typeof apiErrorSchema>;
