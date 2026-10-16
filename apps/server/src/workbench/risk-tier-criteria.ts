import { DEFAULT_RISK_TIER_GUIDE } from '@health-buddy/skills';

/**
 * 风险分层定义的注入点（M2 规格 2.7、4.2、Q8、Q9）。
 *
 * 线上用通用默认定义 DEFAULT_RISK_TIER_GUIDE（packages/skills/src/risk-tier-guide.ts，只维护那一处）：
 * /体检解读 按它给出建议分层和依据，只给健管师看，勾选“采用建议分层”才写进档案。
 * 正式标准确定后替换那份定义即可。测试可以通过 AppOptions.riskTierCriteria 覆盖，
 * 传 null 表示没有定义：此时不给建议分层，模型给出的分层也会被丢弃。
 */
export const RISK_TIER_CRITERIA = Symbol('RISK_TIER_CRITERIA');

export const RISK_TIER_GUIDE: string | null = DEFAULT_RISK_TIER_GUIDE;
