import { z } from 'zod';

/**
 * 运营商（协会）开通和管理（M7 规格 2.1、6.4）。只有平台管理员能开通、修改、停用和恢复。
 * 到期只提醒、不自动停用（Q5）：即将到期由后端按合同结束日期算出。
 */

/** 简称用在协会的登录地址里（Q4）：小写字母、数字和连字符 */
export const operatorSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);

/** 省市代码（行政区划代码前 2 位或 4 位），只作记录和筛选（Q2） */
export const regionCodeSchema = z.string().regex(/^\d{2}(?:\d{2})?$/);

/** 合同到期前多少天开始提醒（Q5） */
export const CONTRACT_EXPIRY_NOTICE_DAYS = 30;
/** 停用原因至少几个字 */
export const SUSPEND_REASON_MIN = 5;

const operatorFields = {
  name: z.string().trim().min(1).max(60),
  region: z.array(regionCodeSchema).max(50).default([]),
  seatLimit: z.number().int().min(0).max(100000),
  contractStart: z.iso.date().nullable(),
  contractEnd: z.iso.date().nullable(),
};

function contractOrder(v: { contractStart: string | null; contractEnd: string | null }) {
  return !v.contractStart || !v.contractEnd || v.contractEnd >= v.contractStart;
}

export const createOperatorRequestSchema = z
  .object({ ...operatorFields, slug: operatorSlugSchema })
  .strict()
  .refine(contractOrder, { message: 'contract end before start' });
export type CreateOperatorRequest = z.infer<typeof createOperatorRequestSchema>;

/** 修改时简称不变（登录地址已经发出去了） */
export const updateOperatorRequestSchema = z
  .object(operatorFields)
  .strict()
  .refine(contractOrder, { message: 'contract end before start' });
export type UpdateOperatorRequest = z.infer<typeof updateOperatorRequestSchema>;

export const suspendOperatorRequestSchema = z
  .object({ reason: z.string().trim().min(SUSPEND_REASON_MIN).max(500) })
  .strict();
export type SuspendOperatorRequest = z.infer<typeof suspendOperatorRequestSchema>;

export const operatorSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  region: z.array(z.string()),
  status: z.enum(['active', 'suspended']),
  suspendedReason: z.string().nullable(),
  seatLimit: z.number().int(),
  /** 已占用的席位：待激活和已激活的健管师（Q7） */
  seatsUsed: z.number().int(),
  contractStart: z.iso.date().nullable(),
  contractEnd: z.iso.date().nullable(),
  /** 合同 30 天内到期或已到期 */
  expiringSoon: z.boolean(),
  expired: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type OperatorSummary = z.infer<typeof operatorSummarySchema>;

export const operatorListResponseSchema = z.object({
  operators: z.array(operatorSummarySchema),
});
export type OperatorListResponse = z.infer<typeof operatorListResponseSchema>;

export const operatorResponseSchema = z.object({ operator: operatorSummarySchema });
export type OperatorResponse = z.infer<typeof operatorResponseSchema>;
