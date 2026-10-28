import type {
  ExpertFailureCategory,
  ExpertOpinion,
  PlanSection,
  RoutingDecision,
  SelectedReason,
  Synthesis,
  SynthesisStatus,
} from '@health-buddy/shared';
import type { ProviderName, Usage } from '../types.js';

/**
 * 专家引擎（M3 规格第三节）用到的专家定义。由 packages/experts 从 expert.md 和 sources.md 构建，
 * 引擎只读这里的字段，不读文件、不读数据库。
 */
export interface ExpertProfile {
  id: string;
  name: string;
  version: string;
  /** sources.md 内容指纹，写进调用记录，可追溯（规格 5.2 第 5 条） */
  sourcesVersion: string;
  /** 规则路由：负责的指标编码；'*' 表示任何一项高于、低于参考范围或没有参考范围的指标（检验解读） */
  indicatorCodes: readonly string[];
  historyCategories: readonly string[];
  maxOutputTokens: number;
  /** 完整的系统提示词：共用规则 + expert.md 正文 + 条目卡片。不变的部分在前，便于提示词缓存 */
  systemPrompt: string;
  /** 给路由模型看的目录条目：擅长和不负责的范围 */
  catalog: { tagline: string; strengths: readonly string[]; outOfScope: readonly string[] };
  /** 这位专家可以被引用的条目卡片（已按环境筛过：正式环境只有已确认的，预览环境含待确认的） */
  cards: readonly CitableCard[];
}

export interface CitableCard {
  cardId: string;
  sourceId: string;
  /**
   * 来源的使用范围（规格 5.1）：referral_only 的卡片只用来判断是否需要转介，
   * 要点和建议引用它一律算无效引用。
   */
  scope: 'advice' | 'referral_only';
  /** 卡片“可引用数值”里的数字（规格 5.2 第 2 条） */
  numbers: readonly number[];
}

/** 规则路由用的一项指标：后端按报告上印的参考范围算好的标记 */
export interface FlaggedIndicator {
  code: string | null;
  direction: 'high' | 'low' | 'no_reference';
  /**
   * 数据来源（M4“请专家看看”）：日常监测的指标不交给“任何指标”（*）的检验解读专家，
   * 只按登记了这个指标编码的专家路由。不写时按报告处理（M3 原行为）
   */
  source?: 'report' | 'monitoring';
}

/**
 * 一次“请专家”的输入。全部由后端组装，已去标识化（规格 7.2 第 4 条）：
 * userContent 里没有姓名、电话、证件号；request 已用 redactClientIdentity 处理。
 */
export interface ConsultationInput {
  /** 发给每位专家的用户消息：客户资料 + 健管师的问题 */
  userContent: string;
  /** 健管师的要求（已去标识），给路由模型看 */
  request: string;
  /** 报告中高于、低于参考范围或没有参考范围的指标（规则路由） */
  flaggedIndicators: readonly FlaggedIndicator[];
  /** 健康史里有记录的类别（给路由模型看） */
  historyCategories: readonly string[];
  /** 输入资料里出现过的全部数值（报告数值、报告参考范围、危急指标阈值、监测读数及差值等） */
  allowedNumbers: readonly number[];
  /** 后端按关键词识别到心理危机信号、疑似急症（不依赖模型） */
  crisisDetected: boolean;
  emergencyDetected: boolean;
  /**
   * 额外的措辞检查（M4 规格 5.4：输入里有孪生资料时，不能下状态结论、把预测说成确定、说成疾病风险）。
   * 返回 true 表示这段文字不合格，按 banned_wording 处理：和 M3 一样去掉这条要点。
   */
  extraWordingCheck?: (text: string) => boolean;
}

export interface ConsultationRequest {
  input: ConsultationInput;
  /** 当前账号可用的全部专家（已去掉暂停的、当前环境不允许的） */
  available: readonly ExpertProfile[];
  /**
   * direct：@专家、专家中心提问，直接调用 forced 里的专家，不经过路由（规格 3.2 第 6 条）。
   * route：/体检解读 自动调用，forced 是“一定要请”，excluded 是“不要请”。
   */
  mode: 'direct' | 'route';
  forced: readonly string[];
  excluded: readonly string[];
  /** 专家中心任务绑定的专家：算作“一定要请”，原因记为 bound */
  bound?: string | null;
  /**
   * route 模式下要不要用模型补充（M4 规格 2.6 之二第 4 条：“请专家看看”只有健管师补充了问题文字时
   * 才用模型补充，否则只按规则命中）。不写为 true
   */
  modelRouting?: boolean;
  /**
   * M5 /方案生成：按方案部分命中的专家（规格 2.5，由调用方按选中的部分和资料算好）。
   * 排在健管师指定之后、指标命中之前
   */
  sectionHits?: readonly { expertId: string; section: PlanSection }[];
}

export type ExpertCallOutcome = 'done' | 'failed' | 'timeout' | 'refused' | 'stopped';

export interface ExpertCallResult {
  expertId: string;
  expertVersion: string;
  sourcesVersion: string;
  selectedReason: SelectedReason;
  status: ExpertCallOutcome;
  failureCategory: ExpertFailureCategory | null;
  /** 通过校验的意见（不合格的要点已移除）；未回复时为空 */
  opinion: ExpertOpinion | null;
  /** 因依据无法核实被移除的要点数量 */
  removedFindings: number;
  /**
   * 模型输出里标出的心理危机、疑似急症信号（任何一次输出标了就算），意见没通过校验、整份不可用时也保留，
   * 汇总和渲染时和关键词、其他专家的信号取“或”（合规审查第 2 条）
   */
  crisisSignal: boolean;
  emergencySignal: boolean;
  provider: ProviderName | null;
  model: string | null;
  usage: Usage;
}

export type ConsultationOutcome = 'done' | 'partial' | 'failed' | 'stopped';

export interface ConsultationResult {
  routing: RoutingDecision;
  calls: ExpertCallResult[];
  synthesis: Synthesis | null;
  synthesisStatus: SynthesisStatus | null;
  status: ConsultationOutcome;
}

/**
 * 引擎通过回调报告每一步，后端负责写库和推送 SSE（规格 3.1）。
 * 回调抛出的错误会中止整次调用（如写库时发现任务已不属于当前健管师）。
 */
export interface ConsultationHooks {
  onRouted?(routing: RoutingDecision): Promise<void> | void;
  onCallStarted?(expertId: string, selectedReason: SelectedReason): Promise<void> | void;
  onCallFinished?(result: ExpertCallResult): Promise<void> | void;
  onSynthesisStarted?(): Promise<void> | void;
}

export interface EngineOptions {
  /** 每位专家的超时（Q13：默认 60 秒） */
  expertTimeoutMs?: number;
  /** 整次调用（含汇总）的超时（Q13：默认 120 秒） */
  totalTimeoutMs?: number;
  /** 每次最多几位专家（Q5：默认 3） */
  maxExperts?: number;
  /**
   * 并发限制（规格 3.3：每位健管师同时进行的专家调用数有上限，超过的排队）。
   * 后端按健管师传入；不传时不限制。
   */
  limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** 只记 id、类别和数量，不记意见原文和客户资料（规格 6.1） */
  logger?: { warn(message: string, fields: Record<string, string | number | null>): void };
}
