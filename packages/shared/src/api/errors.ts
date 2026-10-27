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
  /** 角色不允许做这件事（如非健管师新建客户，M2 规格 3.4）。不涉及具体资源，不泄露存在与否 */
  'forbidden',
  'not_found',
  'conflict',
  'too_many_requests',
  /** 上传的文件太大、太多或页数超限（M2 Q3） */
  'payload_too_large',
  /** 文件类型不支持（按内容判断，M2 Q2） */
  'unsupported_media_type',
  /** 功能依赖的服务（对象存储、队列）还没有配置 */
  'not_configured',
  /** 方案库条目含禁用词、疾病名称、药名或功效承诺（M5 规格 2.4），响应里标出位置，HTTP 400 */
  'invalid_content',
  'internal_error',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: apiErrorCodeSchema });
export type ApiError = z.infer<typeof apiErrorSchema>;
