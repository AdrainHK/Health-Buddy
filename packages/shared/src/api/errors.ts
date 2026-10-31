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
  /** 聊天截图没能转写成文字（M5 规格 2.9“聊天截图”），HTTP 422，reasons 见 CHAT_TRANSCRIPTION_FAILURES */
  'transcription_failed',
  /** 邀请链接无效、过期或已用过（M7 规格 2.4），HTTP 410；不区分具体原因 */
  'invite_expired',
  /** 协会席位用完（M7 规格 2.4 第 5 条），HTTP 409；带 seatsLeft、needed */
  'seat_limit_reached',
  /** 账号还能看到客户明细：名下有客户的健管师不能停用、不能重发邀请，有客户的机构不能新开机构管理员（M7 Q8），HTTP 409 */
  'has_clients',
  'internal_error',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: apiErrorCodeSchema });
export type ApiError = z.infer<typeof apiErrorSchema>;
