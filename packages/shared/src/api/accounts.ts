import { z } from 'zod';
import { findBannedTerms } from '../compliance/index.js';
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

/* ---------- 第 2 步：协会开通机构和账号（规格 2.4，Q7–Q9） ---------- */

/** 运营商管理员能开的角色（机构管理员只读，Q9） */
export const OPERATOR_INVITE_ROLES = ['manager', 'org_admin'] as const;
export const operatorInviteRoleSchema = z.enum(OPERATOR_INVITE_ROLES);
export type OperatorInviteRole = z.infer<typeof operatorInviteRoleSchema>;

/** 单个开通：机构管理员必须选机构，健管师的机构可空 */
export const operatorInviteRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40),
    email: z.email().max(254),
    role: operatorInviteRoleSchema,
    orgId: z.uuid().nullable(),
    /** 健管师的套餐（M7 第 4 步），只能选本协会可售的；不填按试点版 */
    planId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.role !== 'org_admin' || v.orgId !== null, { path: ['orgId'] })
  .refine((v) => v.role === 'manager' || !v.planId, { path: ['planId'] });
export type OperatorInviteRequest = z.infer<typeof operatorInviteRequestSchema>;

/**
 * 协会“账号”页的一行。clientCount 只是数字（协会看不到客户明细），用来提示能否停用、重发邀请；
 * 机构管理员查看时为 null
 */
export const operatorAccountSchema = accountSummarySchema.extend({
  clientCount: z.number().int().nonnegative().nullable(),
  /** 健管师的套餐（没分配时为试点版）；其他角色为 null */
  planId: z.uuid().nullable(),
  planName: z.string().nullable(),
});
export type OperatorAccount = z.infer<typeof operatorAccountSchema>;
export const operatorAccountListResponseSchema = z.object({
  accounts: z.array(operatorAccountSchema),
});
export type OperatorAccountListResponse = z.infer<typeof operatorAccountListResponseSchema>;

export const ORGANIZATION_NAME_MAX = 60;
export const createOrganizationRequestSchema = z
  .object({
    // 机构名称会显示在工作台，不能含禁用词（红线 5，合规审查 S3）
    name: z
      .string()
      .trim()
      .min(1)
      .max(ORGANIZATION_NAME_MAX)
      .refine((v) => findBannedTerms(v).length === 0),
  })
  .strict();
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const organizationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  managerCount: z.number().int().nonnegative(),
  clientCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export const organizationListResponseSchema = z.object({
  organizations: z.array(organizationSummarySchema),
});
export type OrganizationListResponse = z.infer<typeof organizationListResponseSchema>;
export const organizationResponseSchema = z.object({ organization: organizationSummarySchema });
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;

/** 批量开通（规格 2.4 第 2 条）：一次最多 200 行，任何一行有错整批不导入 */
export const ACCOUNT_IMPORT_MAX_ROWS = 200;
export const ACCOUNT_IMPORT_ROW_ERRORS = [
  'role_invalid',
  'name_invalid',
  'email_invalid',
  /** 同一个文件里重复 */
  'email_repeated',
  /** 已被使用（不说被谁用，验收 16） */
  'email_taken',
  'org_not_found',
  /** 机构管理员必须填机构 */
  'org_required',
  /** 机构里已有客户，不能新开机构管理员 */
  'has_clients',
  /** 套餐代码不在本协会可售范围，或填给了机构管理员 */
  'plan_not_available',
] as const;
export type AccountImportRowError = (typeof ACCOUNT_IMPORT_ROW_ERRORS)[number];

/** 行内容原样上传（只限长度），逐行校验在后端，错误按行号返回 */
export const accountImportRowSchema = z
  .object({
    row: z.number().int().min(1).max(10_000),
    displayName: z.string().max(200),
    email: z.string().max(320),
    role: z.string().max(40),
    orgName: z.string().max(200),
    /** 套餐代码（第 5 列，可空，M7 第 4 步） */
    planCode: z.string().max(40).default(''),
  })
  .strict();
export type AccountImportRow = z.infer<typeof accountImportRowSchema>;

export const accountImportRequestSchema = z
  .object({ rows: z.array(accountImportRowSchema).min(1).max(ACCOUNT_IMPORT_MAX_ROWS) })
  .strict();
export type AccountImportRequest = z.infer<typeof accountImportRequestSchema>;

/** 导入成功：每人的一次性链接只在这里出现一次 */
export const accountImportResponseSchema = z.object({
  invites: z.array(inviteResponseSchema.extend({ row: z.number().int() })),
});
export type AccountImportResponse = z.infer<typeof accountImportResponseSchema>;

/** 导入失败（HTTP 400 bad_request，或只有席位不够时 409 seat_limit_reached）的细节 */
export const accountImportErrorSchema = z.object({
  error: z.enum(['bad_request', 'seat_limit_reached']),
  rowErrors: z
    .array(z.object({ row: z.number().int(), code: z.enum(ACCOUNT_IMPORT_ROW_ERRORS) }))
    .default([]),
  seatsLeft: z.number().int(),
  needed: z.number().int(),
});
export type AccountImportError = z.infer<typeof accountImportErrorSchema>;

/** CSV 模板的表头。第 5 列“套餐代码”可以没有（第 2 步的旧模板照常能用） */
export const ACCOUNT_IMPORT_HEADER = ['姓名', '邮箱', '角色', '机构名称', '套餐代码'] as const;
const ROLE_ALIASES: Record<string, string> = {
  健管师: 'manager',
  健康管理师: 'manager',
  机构管理员: 'org_admin',
};

/** 解析一个 CSV 行（支持双引号转义） */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export type AccountCsvParse =
  | { ok: true; rows: AccountImportRow[] }
  | { ok: false; error: 'empty' | 'bad_header' | 'too_many_rows' };

/**
 * 解析批量开通的 CSV。行号按文件里的行算（表头是第 1 行），空行跳过；
 * 角色可以写中文（健管师、机构管理员）。只拆字段，不做业务校验。
 */
export function parseAccountCsv(text: string): AccountCsvParse {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const header = csvFields(lines[0] ?? '');
  const planColumn = header[4] !== undefined && header[4] !== '';
  if (
    ACCOUNT_IMPORT_HEADER.slice(0, 4).some((h, i) => header[i] !== h) ||
    (planColumn && header[4] !== ACCOUNT_IMPORT_HEADER[4])
  ) {
    return { ok: false, error: lines.every((l) => l.trim() === '') ? 'empty' : 'bad_header' };
  }
  const rows: AccountImportRow[] = [];
  lines.slice(1).forEach((line, i) => {
    if (line.trim() === '') return;
    const [displayName = '', email = '', role = '', orgName = '', planCode = ''] = csvFields(line);
    rows.push({
      row: i + 2,
      displayName: displayName.slice(0, 200),
      email: email.slice(0, 320),
      role: (ROLE_ALIASES[role] ?? role).slice(0, 40),
      orgName: orgName.slice(0, 200),
      planCode: planColumn ? planCode.slice(0, 40) : '',
    });
  });
  if (rows.length === 0) return { ok: false, error: 'empty' };
  if (rows.length > ACCOUNT_IMPORT_MAX_ROWS) return { ok: false, error: 'too_many_rows' };
  return { ok: true, rows };
}
