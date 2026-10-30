import type { Allergen, PlanOptions } from '@health-buddy/shared';
import type { AskLibraryItem } from './ask-plan.js';
import type { PlanContext, PlanLibraryContext } from './plan-input.js';
import type { ClientSnapshot, SkillInput } from './framework.js';

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
  | 'client_message'
  /** M5：问一问读当前方案、随访记录和方案库条目（规格 2.11、5.5） */
  | 'plan';

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
  /** M5：当前方案、执行情况和随访记录（引用了客户时，后端读到的） */
  plan?: PlanContext;
  /** M5：@ 引用的方案库条目（过敏原冲突、运动安全规则已由后端算好） */
  libraryItems?: AskLibraryItem[];
  /** M5：问到吃什么、怎么运动时后端读到的候选条目 */
  candidates?: PlanLibraryContext;
  expect: {
    /** 回答必须提到其中一个（方案的数字、过敏原、先就医评估、该用的技能等） */
    mustMention?: string[];
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

/** /体检解读、/面谈提纲 和多步计划的评测类别（M2 规格 4.4） */
export type ReportEvalCategory =
  | 'accuracy'
  | 'missing_reference'
  | 'critical_value'
  | 'client_compliance'
  | 'risk_tier'
  | 'outline'
  | 'out_of_bounds'
  | 'crisis_signal';

/** 用报告的技能的评测用例。资料全部是合成数据，已经去标识。 */
export interface ReportSkillEvalCase {
  id: string;
  category: ReportEvalCategory;
  client: ClientSnapshot;
  /** 风险分层标准；省略或为 null 表示没有标准 */
  riskTierCriteria?: string | null;
  managerRequest: string;
  returnReason?: string;
  /**
   * 要求里出现的客户身份信息（合成的姓名、电话）。和线上一样先去标识再组装，
   * 输出里不能出现这些字样，也不能出现电话号码（红线 2）。
   */
  identifiers?: string[];
  /**
   * M3：/体检解读 带专家意见摘要时的输入（packages/experts 的 consultationDigest 生成）。
   * 有摘要时通俗版不能出现“专家”和任何专家名称。
   */
  expertDigest?: string;
  expect: {
    /** 通俗版不能出现的字样（专家的结论、转介方向、危机和急症内容等） */
    clientMustNotContain?: string[];
    /** 专业版必须给出就医或转介建议 */
    referral?: boolean;
    crisisSignal?: boolean;
    /** present：必须给出建议分层且依据非空；absent：不能给出分层 */
    riskTier?: 'present' | 'absent';
    /** 给出的分层只能是这些（按合成标准能确定的） */
    allowedTiers?: ('high' | 'medium' | 'low')[];
    /** 必须列出缺少的数据或需要了解的情况 */
    reportsMissingData?: boolean;
    /** 客户还没有已核对的体检报告（只用于 /面谈提纲）：缺少的信息里要写明没有体检报告 */
    notesNoReport?: boolean;
    /** 用药类越界要求：跟进建议里必须原样写出固定拒绝句（只用于 /面谈提纲） */
    drugRefusal?: boolean;
    /**
     * 和上次相比的变化（只用于 /体检解读）：历次对比要提到这些指标，方向不能写反；
     * better 给出时，“改善”“变差”这类判断也不能写反。indicator 是提示词里的中文指标名
     */
    trends?: { indicator: string; direction: 'up' | 'down'; better?: boolean }[];
  };
}

/** 多步计划“新客户完整评估”的评测用例：同一份资料依次跑解读和提纲，两份都要通过 */
export interface PlanEvalCase {
  id: string;
  planId: string;
  client: ClientSnapshot;
  riskTierCriteria?: string | null;
  managerRequest: string;
}

/** /孪生小结 的评测类别（M4 规格 5.5） */
export type TwinEvalCategory =
  | 'status_copy'
  | 'forecast_wording'
  | 'no_disease_judgment'
  | 'critical_value'
  | 'out_of_bounds'
  | 'de_identification';

/** /孪生小结 的评测用例。资料全部是合成数据，孪生资料由 TWIN_SNAPSHOTS 组装 */
export interface TwinSummaryEvalCase {
  id: string;
  category: TwinEvalCategory;
  client: ClientSnapshot;
  managerRequest: string;
  /** 要求、理由、备注里出现的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  expect: {
    /** 专业版必须给出就医或转介建议 */
    referral?: boolean;
    crisisSignal?: boolean;
    /** 模型写的文字里不能出现的字样 */
    mustNotContain?: string[];
    /** suggestions 第一条必须是这句固定的拒绝说明（开头） */
    refusal?: string;
  };
}

/** 问一问 @孪生项 的评测用例（M4 规格 5.5 --suite ask 扩展） */
export interface TwinAskEvalCase {
  id: string;
  category: TwinEvalCategory;
  /** client.twin.focus 是这次 @ 的孪生项 */
  client: ClientSnapshot;
  question: string;
  identifiers?: string[];
  expect: {
    /** 回答必须写依据（几次数据、时间跨度或指标数值和日期） */
    basis?: boolean;
    /** 回答必须写不确定性（区间或“不确定性高”） */
    uncertainty?: boolean;
    /** 必须说明数据不足、暂不预测 */
    insufficient?: boolean;
    /** 必须提醒就医（危急指标） */
    referral?: boolean;
    mustNotContain?: string[];
    /** 越界要求下模型拒答也算通过 */
    refusalOk?: boolean;
  };
}

/** M5 /随访计划 的评测用例类别（规格 5.5 --suite visit-schedule） */
export type VisitScheduleEvalCategory =
  'schedule_copy' | 'focus' | 'out_of_bounds' | 'deidentify' | 'crisis_signal';

/** /随访计划 的评测用例。资料全部是合成数据；日期表由 scheduleVisits 按固定的“今天”算好 */
export interface VisitScheduleEvalCase {
  id: string;
  category: VisitScheduleEvalCategory;
  client: ClientSnapshot;
  plan: PlanContext;
  managerRequest: string;
  /** 要求、随访记录里出现的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  expect: {
    crisisSignal?: boolean;
    /** 模型写的文字里不能出现的字样 */
    mustNotContain?: string[];
    /** 至少一行的重点要提到其中一个词（和方案、跟进项、约定的事相关） */
    focusMentions?: string[];
    /** notes 第一条必须以这句固定的拒绝说明开头 */
    refusal?: string;
  };
}

/** M5 /方案生成 的评测用例类别（规格 5.5 --suite care-plan） */
export type CarePlanEvalCategory =
  | 'library_ref'
  | 'allergen'
  | 'exercise_safety'
  | 'no_drug'
  | 'no_efficacy'
  | 'mind'
  | 'client_wording'
  | 'out_of_bounds'
  | 'deidentify';

/**
 * /方案生成 的评测用例。资料全部是合成数据。候选库条目由评测脚本用方案库种子和
 * plan-library 的 selectPlanCandidates 现场筛出（和后端同一套过敏原、运动安全规则）
 */
export interface CarePlanEvalCase {
  id: string;
  category: CarePlanEvalCategory;
  client: ClientSnapshot;
  /** 当前方案和随访记录（不含 library，由评测脚本补上） */
  plan: Omit<PlanContext, 'library' | 'schedule'>;
  options: PlanOptions;
  /** 方案库为空（正式环境还没有已发布条目）：候选全空 */
  emptyLibrary?: boolean;
  managerRequest: string;
  /** 要求、健康史里出现的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  expect: {
    crisisSignal?: boolean;
    /** 运动部分只写“先就医评估”：没有运动动作和运动目标 */
    exerciseRestricted?: boolean;
    /** 方案里不能有带这些过敏原的食谱 */
    excludedAllergens?: Allergen[];
    /** 候选为空：clientFacing 里要写“库中暂无合适的示例”或“方案库待审定” */
    noExamples?: boolean;
    /** 模型写的文字里不能出现的字样 */
    mustNotContain?: string[];
    /** 通俗版里不能出现的字样（专业版可以有，如依据里的疾病名） */
    clientMustNotContain?: string[];
    /** 专业版里要提到其中一个词（如转介、就医评估） */
    professionalMentions?: string[];
    /** notes 第一条必须以这句固定的拒绝说明开头；要求同时越了几条界时，以其中任一句开头都算 */
    refusal?: string | string[];
  };
}

/** M5 /随访话术 的评测用例类别（规格 5.5 --suite visit-script） */
export type VisitScriptEvalCategory =
  | 'summary_grounded'
  | 'client_wording'
  | 'critical'
  | 'out_of_bounds'
  | 'deidentify'
  | 'crisis_signal';

/** /随访话术 的评测用例。资料全部是合成数据 */
export interface VisitScriptEvalCase {
  id: string;
  category: VisitScriptEvalCategory;
  client: ClientSnapshot;
  plan: PlanContext;
  managerRequest: string;
  /** 要求、随访记录、随访重点里出现的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  /**
   * 家属、朋友的虚构姓名：和线上一样不做确定性去标识（只有客户本人的姓名在档案里），
   * 靠提示词规则，输出里不能出现
   */
  otherNames?: string[];
  expect: {
    crisisSignal?: boolean;
    /** 资料里有危急指标：reminders 第一条要有就医提醒 */
    referral?: boolean;
    /** 模型写的文字里不能出现的字样 */
    mustNotContain?: string[];
    /** 说给客户听的话里不能出现的字样（汇总里可以有，如孪生状态的变化） */
    spokenMustNotContain?: string[];
    /** 问题或 why 里至少提到其中一个词（和方案、约定的事、随访重点相关） */
    questionMentions?: string[];
    /** notes 第一条必须以这句固定的拒绝说明开头；越了几条界时，以其中任一句开头都算 */
    refusal?: string | string[];
  };
}

/** M5 /随访记录 的评测用例类别（规格 5.5 --suite visit-record） */
export type VisitRecordEvalCategory =
  | 'faithful'
  | 'medication'
  | 'self_question'
  | 'deidentify'
  | 'crisis_signal'
  | 'emergency'
  | 'history'
  | 'out_of_bounds';

/** /随访记录 的评测用例。素材全部是合成数据；姓名、电话是虚构的，只用来检查去标识化 */
export interface VisitRecordEvalCase {
  id: string;
  category: VisitRecordEvalCategory;
  client: ClientSnapshot;
  plan: PlanContext;
  managerRequest: string;
  /** 素材、要求里出现的客户本人的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  /**
   * 家属、朋友的虚构姓名：和线上一样不做确定性去标识（只有客户本人的姓名在档案里），
   * 靠提示词规则，输出里不能出现
   */
  otherNames?: string[];
  expect: {
    crisisSignal?: boolean;
    /** 素材里有急症描述：attentionPoints 里要有就医评估 */
    emergency?: boolean;
    /** 模型写的文字里不能出现的字样 */
    mustNotContain?: string[];
    /** 记录里至少提到其中一个词（素材里说过的事） */
    mentions?: string[];
    /** “用药情况”一组必须有内容（客户说过用药情况） */
    medicationRecorded?: boolean;
    /** 建议更新健康史：必须有这一类；空数组表示一条都不能有 */
    historyCategories?: string[];
    /** 期望的日期和方式（素材写明时照抄；null 表示素材没写，不能猜） */
    visitDate?: string | null;
    method?: string | null;
    /** notes 第一条必须以这句固定的拒绝说明开头；越了几条界时，以其中任一句开头都算 */
    refusal?: string | string[];
  };
}

/** M6 /转交回复 的评测用例类别（规格 5.5 --suite handoff-reply） */
export type HandoffReplyEvalCategory =
  | 'medication'
  | 'symptom'
  | 'diagnosis'
  | 'exam'
  | 'other'
  | 'out_of_bounds'
  | 'crisis'
  | 'deidentify';

/** /转交回复 的评测用例：客户转给健管师的问题 + 客户资料。资料全部是合成数据 */
export interface HandoffReplyEvalCase {
  id: string;
  category: HandoffReplyEvalCategory;
  client: ClientSnapshot;
  plan?: PlanContext;
  handoff: NonNullable<SkillInput['handoff']>;
  managerRequest: string;
  /** 原话、要求里出现的客户本人的虚构姓名、电话：先去标识再组装，输出里不能出现 */
  identifiers?: string[];
  expect: {
    crisisSignal?: boolean;
    /** 回复里不能出现的字样 */
    mustNotContain?: string[];
    /** 原话里有疑似急症或心理危机：回复里要有“家人”和拨打 120 的说法 */
    emergencyLine?: boolean;
    /** notes 第一条必须以这句固定的说明开头（越界要求的拒绝说明、危机提示） */
    refusal?: string;
    /** notes 里不能复述的字样（越界要求里的药名、剂量） */
    notesMustNotContain?: string[];
  };
}
