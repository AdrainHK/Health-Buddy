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
  /**
   * 来源（规格 2.7）：manual 是在档案里手动设定；artifact 是审核 /体检解读 时勾选“采用建议分层”。
   * 机构管理员看不到产物（Q14），给他的响应里 sourceArtifactId 为空。
   */
  source: z.enum(['manual', 'artifact']),
  sourceArtifactId: z.uuid().nullable(),
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

/**
 * /体检解读 专业版里的建议分层（规格 2.7、4.2）。只在输入里给了分层标准时才有；
 * 健管师确认产物时勾选“采用建议分层”，后端在同一事务里写入分层历史。
 */
export const riskTierSuggestionSchema = z.object({
  tier: riskTierSchema,
  /** 依据，写进分层历史的理由 */
  reason: z.string().min(1).max(RISK_TIER_REASON_MAX),
});
export type RiskTierSuggestion = z.infer<typeof riskTierSuggestionSchema>;
