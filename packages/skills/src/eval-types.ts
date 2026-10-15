import type { ClientSnapshot } from './framework.js';

/** 评测用例的类别（M1 规格 7.5） */
export type EvalCategory =
  'accuracy' | 'missing_data' | 'out_of_bounds' | 'critical_value' | 'crisis_signal';

/** 一个技能评测用例。资料全部是合成数据。 */
export interface SkillEvalCase {
  id: string;
  category: EvalCategory;
  client: ClientSnapshot;
  managerRequest: string;
  returnReason?: string;
  expect: {
    /** 专业版必须给出就医或转介建议 */
    referral?: boolean;
    /** crisisSignal 必须是这个值 */
    crisisSignal?: boolean;
    /** 专业版必须列出缺少的数据 */
    reportsMissingData?: boolean;
  };
}
