import type { ExpertOpinion, ReferralUrgency, TwinRef } from '@health-buddy/shared';
import type { ClientSnapshot } from '@health-buddy/skills';

/**
 * 专家评测用例（M3 规格 8.1）。全部是合成数据（scripts/seed 和 packages/skills 的合成资料），
 * 不对应任何真实的人。每位专家的目标是至少 15 条，M3 第一批先各写 5 条以上，补齐前不能 published。
 */
export type ExpertEvalCategory =
  | 'in_scope' // 范围内准确
  | 'citation' // 引用有效
  | 'no_invented_threshold' // 不编造阈值
  | 'out_of_scope' // 超出范围
  | 'referral' // 转介
  | 'boundary' // 越界指令（下诊断、给药物剂量、忽略规则）
  | 'crisis' // 危机和急症
  | 'deidentify' // 去标识化
  | 'expert_specific' // 专家特有用例
  | 'twin'; // M4“请专家看看”：针对孪生项的意见

/** 每位专家评测集的目标条数（规格 8.1） */
export const EXPERT_EVAL_TARGET = 15;

export interface ExpertEvalCase {
  id: string;
  expertId: string;
  category: ExpertEvalCategory;
  /** 去标识化的合成客户资料；一般性问题为空 */
  client: ClientSnapshot | null;
  /** 健管师的问题 */
  question: string;
  /** 去标识化用例：问题里出现的合成姓名等字样，组装时会被替换，意见里也不能出现 */
  identifiers?: string[];
  /** M4“请专家看看”针对的孪生项（client.twin 必须有值） */
  twinRefs?: TwinRef[];
  expect: {
    inScope?: boolean;
    referral?: { needed: boolean; urgency?: ReferralUrgency };
    crisisSignal?: boolean;
    emergencySignal?: boolean;
    /** 意见任何地方都不能出现的字样（合成姓名、电话、药名、剂量等） */
    mustNotContain?: string[];
    /** 意见里不能出现的说法：按分句查，含否定、疑问或交给医生的分句不查（“不要自行停用”“是否可以停药由医生决定”） */
    mustNotMatch?: RegExp[];
    /** 期望要点：每组里至少出现一个词 */
    mentionsAny?: string[][];
    /** 报告没印参考范围的指标（检验解读）：不能对它下高低判断 */
    noJudgmentFor?: string[];
    /** 用例期望引用到的卡片（上线前这些卡片必须已确认，规格 5.4） */
    citedCards?: string[];
  };
}

/** 路由评测用例（规格 8.2，--suite expert-routing） */
export interface RoutingEvalCase {
  id: string;
  client: ClientSnapshot;
  request: string;
  forced?: string[];
  excluded?: string[];
  /** M4“请专家看看”针对的孪生项：规则只按这些孪生项涉及的指标走，没写问题时不用模型补充 */
  twinRefs?: TwinRef[];
  expect: {
    /** 必须被选中的专家（孪生项按方面对应的指标路由） */
    mustSelect?: string[];
    /** 期望模型补充的专家（规则命中的由引擎保证全选，评分时另算） */
    modelShouldAdd?: string[];
    /** 不应该被选中的专家 */
    mustNotSelect?: string[];
    /**
     * 一位专家都不该选（如“请专家看看”睡眠、没写问题：没有负责睡眠的专家，
     * 后端回固定说明 NO_TWIN_EXPERT，不调用专家）
     */
    selectNone?: boolean;
  };
}

/** 汇总评测用例（规格 8.2，--suite expert-synthesis） */
export interface SynthesisEvalCase {
  id: string;
  opinions: { expertId: string; opinion: ExpertOpinion }[];
  expect: {
    /** 至少有一处分歧，话题里包含这些词之一 */
    disagreementAbout?: string[];
    crisisSignal?: boolean;
  };
}
