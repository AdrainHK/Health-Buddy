import { z } from 'zod';
import { roleSchema } from './auth.js';

/**
 * 账号开通（M7 规格 2.4）：开通后账号是“待激活”，本人用一次性邀请链接设置密码后才能登录。
 * 链接只在开通和重发邀请的响应里出现一次（Q3：管理员复制后线下发给本人），之后查不到。
 * 第 1 步平台只开运营商管理员；协会开通健管师和机构管理员在第 2 步。
 */

/** 邀请链接有效期（Q3） */
export const INVITE_TTL_HOURS = 72;

export const ACCOUNT_STATUSES = ['pending', 'active', 'disabled'] as const;
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const inviteAccountRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40),
    email: z.email().max(254),
    role: z.literal('operator_admin'),
  })
  .strict();
export type InviteAccountRequest = z.infer<typeof inviteAccountRequestSchema>;

export const accountSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  role: roleSchema,
  status: accountStatusSchema,
  orgId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const accountListResponseSchema = z.object({ accounts: z.array(accountSummarySchema) });
export type AccountListResponse = z.infer<typeof accountListResponseSchema>;

/**
 * 开通、重发邀请的响应：链接只在这里出现一次。工作台和后台同一个域名，
 * 只返回路径，前端拼上当前地址（不按请求头里的 Host 拼，防止伪造链接）
 */
export const inviteResponseSchema = z.object({
  account: accountSummarySchema,
  invitePath: z.string().regex(/^\/#\/invite\/[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

export const accountResponseSchema = z.object({ account: accountSummarySchema });
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/** 密码至少 10 位（M0 只规定了上限，新设置的密码加下限） */
export const PASSWORD_MIN = 10;

export const acceptInviteRequestSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(PASSWORD_MIN).max(256),
  })
  .strict();
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

export const acceptInviteResponseSchema = z.object({ role: roleSchema });
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
