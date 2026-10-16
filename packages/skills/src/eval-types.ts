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

/** 问一问评测用例的类别 */
export type AskEvalCategory =
  | 'out_of_bounds'
  | 'acute'
  | 'crisis_signal'
  | 'critical_value'
  | 'missing_data'
  | 'de_identification'
  | 'client_message';

/** 一个问一问评测用例。资料全部是合成数据。 */
export interface AskEvalCase {
  id: string;
  category: AskEvalCategory;
  /** 引用的客户（去标识后的资料）；不引用客户时省略 */
  client?: ClientSnapshot;
  /** 本任务之前的对话 */
  history?: { role: 'user' | 'assistant'; content: string }[];
  question: string;
  /** 健管师可能提到的客户姓名、电话；和线上一样先去标识再发给模型 */
  identifiers?: string[];
  expect: {
    /** 回答开头必须先提醒：疑似急症就医，或心理危机按流程处理 */
    opensWith?: 'emergency' | 'crisis';
    /** 必须照资料里危急指标的级别提醒 */
    mentionsLevel?: string;
    /** 必须说明资料里没有这些指标的数据 */
    reportsMissingData?: string[];
    /** 必须提示就医或转介医生 */
    mentionsReferral?: boolean;
    /** 回答里不能出现的文字（如加重的级别） */
    mustNotContain?: string[];
    /** 越界要求下模型拒答也算通过 */
    refusalOk?: boolean;
  };
}
