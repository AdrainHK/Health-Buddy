/**
 * 风险分层标准（M2 规格 2.7、4.2、Q8、Q9）。
 *
 * 分层标准是医学和服务规则，要由产品负责人或医学顾问提供，标准确定后由平台管理员在总后台设置（Q9）。
 * 在那之前没有确认的标准：/体检解读 不给出建议分层，只写“需要了解的情况”，
 * 后端也会丢弃模型给出的分层（规格 4.3 第 4 条“分层只用确认后的分层标准”）。
 * 测试通过 AppOptions.riskTierCriteria 注入合成标准，验证“采用建议分层”的流程。
 */
export const RISK_TIER_CRITERIA = Symbol('RISK_TIER_CRITERIA');

/** 已确认的分层标准。还没有，保持为空，不要在这里自己编写标准 */
export const CONFIRMED_RISK_TIER_CRITERIA: string | null = null;
