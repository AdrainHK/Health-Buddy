import { z } from 'zod';

/**
 * 风险分层（M2 规格 2.7）。M2 由健管师手动设定，必须填理由（Q8、Q9）。
 * 分层只给健管师看，不进通俗版、复制和导出的内容（Q20）。
 */
export const RISK_TIERS = ['high', 'medium', 'low'] as const;
export const riskTierSchema = z.enum(RISK_TIERS);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const RISK_TIER_REASON_MAX = 500;

export const riskTierRecordSchema = z.object({
  id: z.uuid(),
  tier: riskTierSchema,
  reason: z.string(),
  setBy: z.uuid(),
  /** 设定人姓名；客户从别的健管师转来时，看不到原健管师的姓名，为空 */
  setByName: z.string().nullable(),
  setAt: z.iso.datetime(),
});
export type RiskTierRecord = z.infer<typeof riskTierRecordSchema>;

export const setRiskTierRequestSchema = z.object({
  tier: riskTierSchema,
  reason: z.string().trim().min(1).max(RISK_TIER_REASON_MAX),
});
export type SetRiskTierRequest = z.infer<typeof setRiskTierRequestSchema>;

/** 分层历史，从新到旧；第一条就是当前分层 */
export const riskTierHistoryResponseSchema = z.object({ tiers: z.array(riskTierRecordSchema) });
export type RiskTierHistoryResponse = z.infer<typeof riskTierHistoryResponseSchema>;

export const riskTierResponseSchema = z.object({ tier: riskTierRecordSchema });
export type RiskTierResponse = z.infer<typeof riskTierResponseSchema>;
