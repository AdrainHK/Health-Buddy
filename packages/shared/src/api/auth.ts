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
