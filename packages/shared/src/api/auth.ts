import { z } from 'zod';

/** 账号层级。客户账号在 M6 启用，届时再加入。 */
export const roleSchema = z.enum(['platform_admin', 'operator_admin', 'org_admin', 'manager']);
export type Role = z.infer<typeof roleSchema>;

export const loginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  operator: z
    .object({
      id: z.uuid(),
      name: z.string(),
      brandColor: z.string().nullable(),
    })
    .nullable(),
  orgId: z.uuid().nullable(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const meResponseSchema = z.object({ user: currentUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * 修改自己的账号设置（M4 Q13）：时区决定跟进清单的“今日”。null 表示不设置，用浏览器时区。
 * 时区名是否存在由后端用数据库的时区表再校验。
 */
export const updateMeRequestSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/)
      .nullable(),
  })
  .strict();
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
