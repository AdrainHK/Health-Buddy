import { z } from 'zod';
import { roleSchema } from './auth.js';

/**
 * 后台审计日志（M7 规格 2.7）：只能追加。平台看全部，运营商管理员只看本协会的。
 * before、after 只有业务字段，邮箱是掩码，没有密码和令牌。
 */
export const AUDIT_OBJECT_TYPES = [
  'operator',
  'organization',
  'user',
  'plan',
  'content_rules',
] as const;
export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'suspended',
  'resumed',
  'invited',
  'reinvited',
  'activated',
  'disabled',
  'enabled',
  'retired',
  'plan_assigned',
] as const;

export const auditLogQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    operatorId: z.uuid().optional(),
    objectType: z.enum(AUDIT_OBJECT_TYPES).optional(),
  })
  .strict()
  .refine((v) => v.to >= v.from, { message: 'to before from' });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  operatorId: z.uuid().nullable(),
  actorId: z.uuid().nullable(),
  actorRole: roleSchema.nullable(),
  objectType: z.enum(AUDIT_OBJECT_TYPES),
  objectId: z.uuid(),
  action: z.enum(AUDIT_ACTIONS),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/** 一次最多返回的条数；导出 CSV 同样受限 */
export const AUDIT_LOG_LIMIT = 2000;

export const auditLogResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  truncated: z.boolean(),
});
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
