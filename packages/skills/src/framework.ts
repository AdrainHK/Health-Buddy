/**
 * 工作台技能框架（M1 规格 7.1）。
 *
 * 每个技能是 src/<技能 id>/ 下的一个目录：
 * - skill.md：元数据（frontmatter）和技能自己的提示词，便于合规审查
 * - index.ts：输出结构（zod）、把客户资料组装成模型输入、把模型输出渲染成产物
 * - evals/：评测用例
 *
 * 合规规则由框架统一执行，不依赖每个技能自己的提示词：
 * 所有产物都是草稿；有通俗版的产物都由后端拼接免责声明并过禁用词检查。
 */
import { readFileSync } from 'node:fs';
import {
  findBannedTerms,
  type AbnormalFlag,
  type CriticalFlag,
  type RiskTier,
  type RiskTierSuggestion,
} from '@health-buddy/shared';
import type { z } from 'zod';
import type { PlanContext } from './plan-input.js';
import type { TwinSnapshot } from './twin-input.js';
import type { WordingIssue } from './wording.js';

export const SKILL_MODES = ['plan', 'craft'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export interface SkillMeta {
  id: string;
  /** 产物类型，写进 artifacts.kind */
  kind: string;
  /** 产物标题，用于导出文件的标题和文件名（不含客户姓名） */
  title: string;
  requiresClient: boolean;
  modes: SkillMode[];
  /** 是否有给客户看的通俗版 */
  clientFacing: boolean;
  /** 是否涉及健康判断（涉及的产物必须审核，M1 所有产物都审核） */
  involvesHealthJudgment: boolean;
  /**
   * 不需要健管师再写要求的技能（验收反馈 8）：输入框为空也能发送，后端用这段文字当作要求。
   * skill.md 里不写 defaultRequest 时为 null，必须写要求。
   */
  defaultRequest: string | null;
}

/**
 * 发给模型的客户资料。按 Q9 去标识化：没有姓名、联系方式、证件号，年龄只给年龄段。
 * 由后端组装，技能只读这里的内容。
 */
export interface ClientSnapshot {
  /** 如 "60-69"；出生年份未知时为 null */
  ageBand: string | null;
  gender: 'female' | 'male' | 'other' | null;
  /** 最近 30 天的日常监测，按指标分组，日期升序 */
  monitoring: {
    metric: string;
    unit: string;
    readings: { date: string; value: number }[];
  }[];
  /** 最近一份体检报告的结构化指标 */
  latestReport: {
    date: string;
    indicators: {
      code: string;
      value: number;
      unit: string;
      refLow?: number | undefined;
      refHigh?: number | undefined;
    }[];
  } | null;
  /** 后端按阈值识别出的危急指标 */
  criticalFlags: CriticalFlag[];
  /**
   * 这次要解读的已核对报告的完整内容（M2 规格 2.5 第 2 条），只给用报告的技能
   * （/体检解读、/面谈提纲）组装。高低标记由后端按报告上印的参考范围算好（Q10）。
   */
  reportDetail?: ReportDetail | null;
  /** 健康史（Q12），文字在组装时已去掉姓名和联系方式 */
  healthHistory?: HealthHistoryEntry[];
  /** 当前风险分层（只给健管师看的专业版用，Q20）；未分层为 null */
  riskTier?: { tier: RiskTier; setOn: string } | null;
  /**
   * 数字孪生（M4 规格 5.2）：只给 /孪生小结、问一问和专家组装，不给有通俗版的技能（5.4 第 3 条）。
   * 手动调整理由和跟进备注在组装提示词前去标识（redactTwin）
   */
  twin?: TwinSnapshot | null;
}

/** 报告里的一项已核对指标 */
export interface ReportIndicatorDetail {
  /** 目录指标的编码；未收录指标为 null（Q10） */
  code: string | null;
  /** 未收录指标在报告上的原始名称；目录指标为 null */
  rawName: string | null;
  /** 数值（已换算成目录单位）；未收录指标的文字结果（如“阴性”）为 null */
  value: number | null;
  /** 数值为空时报告上的原文结果 */
  textValue: string | null;
  unit: string | null;
  /** 报告上印的参考范围原文 */
  refText: string | null;
  refLow: number | null;
  refHigh: number | null;
  /** 后端按报告参考范围算出的高低标记 */
  abnormal: AbnormalFlag;
  /** 之前已核对报告里同一指标、同一单位的数值，日期升序（规格 4.2） */
  previous: { date: string; value: number }[];
}

export interface ReportDetail {
  date: string;
  indicators: ReportIndicatorDetail[];
  /** 之前已核对报告的日期（升序） */
  previousReportDates: string[];
}

export const HEALTH_HISTORY_CATEGORIES = [
  'past_history',
  'family_history',
  'medication',
  'allergy',
  'lifestyle',
] as const;

export interface HealthHistoryEntry {
  category: (typeof HEALTH_HISTORY_CATEGORIES)[number];
  content: string;
}

export interface SkillInput {
  client: ClientSnapshot;
  /** 健管师这次的要求（原话） */
  managerRequest: string;
  /** 退回重写时健管师填写的原因 */
  returnReason?: string | undefined;
  /**
   * 风险分层标准（规格 4.2、Q8、Q9）。为空表示还没有确认的标准，模型不给分层，
   * 只写“需要了解的情况”；后端也会丢弃这时模型给出的分层。
   */
  riskTierCriteria?: string | null | undefined;
  /**
   * 专家意见摘要（M3 规格 2.7、Q8）：/体检解读 调用专家后由后端组装，只给专业版参考；
   * 通俗版可以改写其中的生活方式建议，但不出现专家名称和专家结论。没有调用专家时为空。
   */
  expertDigest?: string | undefined;
  /**
   * 方案和随访（M5 规格 5.2）：当前方案摘要、最近的随访记录（跟进项在孪生资料里）；
   * /随访计划 还有后端算好的随访日期。只给声明了 planContext 的技能组装
   */
  plan?: PlanContext | undefined;
}

/** 技能输出渲染后的产物内容。clientFacing 还没有拼接免责声明。 */
export interface SkillArtifact {
  professional: string;
  clientFacing: string;
  /** 健管师转述了心理危机信号，审核栏要醒目提示 */
  crisisSignal: boolean;
  /** 建议分层（只有 /体检解读，规格 2.7）；只给健管师看 */
  riskTierSuggestion?: RiskTierSuggestion | null;
  /**
   * 结构化内容（M5：随访计划的日程、方案的条目和目标、随访记录），写进 artifacts.structured；
   * 由后端按 kind 的 schema 再校验
   */
  structured?: unknown;
}

export interface SkillDefinition<S extends z.ZodType = z.ZodType> extends SkillMeta {
  /** 技能自己的提示词（skill.md 正文） */
  prompt: string;
  outputSchema: S;
  /**
   * 需要客户有已核对的报告（M2 规格 2.6）：没有时不生成，提示“请先上传并核对报告”。
   * 后端会为这类技能组装 reportDetail、健康史和当前分层。
   */
  requiresReport?: boolean;
  /**
   * 用报告，但报告可选（/面谈提纲，产品负责人验收反馈）：@ 了报告就用那一份，没有 @ 时用
   * 最近一份已核对报告，客户一份已核对报告都没有时照常生成（按健康史、日常监测和档案）。
   * 后端同样组装 reportDetail（可能为空）、健康史和当前分层。requiresReport 为 true 时隐含这一项。
   */
  usesReport?: boolean;
  /**
   * 通俗版怎么处理危急指标。defer（默认，M1）：只写“您的健管师会和您单独沟通”；
   * omit（/体检解读，Q19）：通俗版完全不提这项指标，由健管师先电话联系客户。
   */
  criticalInClientText?: 'defer' | 'omit';
  /** 通俗版可以照原文写报告上印的参考范围（M2 规格 2.5 示例、4.2） */
  reportReferenceInClientText?: boolean;
  /** 大模型网关的用途，默认 skill（规格 4.1：/体检解读 用 report_interpretation） */
  route?: 'skill' | 'report_interpretation';
  /** 是否接入专家（M3 规格 2.4、Q7）：auto 执行时自动选择专家；默认 none */
  experts?: 'none' | 'auto';
  /** 执行步骤里“调用技能”那一步的 i18n 键，默认 steps.runSkill */
  runStepLabel?: string;
  /**
   * 读取数字孪生（M4 /孪生小结）：后端组装 client.twin，执行步骤加“正在读取数字孪生”“正在计算趋势”；
   * 客户没有任何已核对报告和监测数据时不生成（409 no_twin_data）。只能用于没有通俗版的技能
   */
  usesTwin?: boolean;
  /**
   * 数值校验（M4 规格 5.2，沿用 M3 3.4）：返回模型自己写的文字，后端核对其中的数值都能在输入里找到；
   * 有输入以外的数值时带纠正说明重试一次，仍不合格不保存草稿
   */
  numberCheckTexts?(output: z.output<S>): string[];
  /**
   * 方案和随访的上下文（M5 规格 5.2）：后端组装 SkillInput.plan，执行步骤加“正在读取数字孪生”
   * “正在读取当前方案”；visit_schedule 再加“正在排随访日期”（日期由后端算，Q17），
   * care_plan 再加“正在选择食谱和动作”（候选库条目、目标模板和方案选项由后端组装）
   */
  planContext?: 'visit_schedule' | 'care_plan';
  /**
   * 结构校验（M5 规格 5.2）：随访行数和日期必须和输入一致、条目必须在候选里、参数必须在范围里。
   * 返回不合格的类别（不带内容）；有问题时带 validationNote 重试一次，仍不合格不保存草稿
   */
  validateOutput?(output: z.output<S>, input: SkillInput): string[];
  /** 结构校验没通过时附在用户消息后面的纠正说明 */
  validationNote?(categories: readonly string[]): string;
  /** 把客户资料和健管师的要求组装成用户消息 */
  buildUserMessage(input: SkillInput): string;
  /** 把模型输出渲染成产物。input 是这次的输入，用来由后端确定性地写出数值表 */
  render(output: z.output<S>, input?: SkillInput): SkillArtifact;
  /**
   * 保存前的确定性措辞检查（/面谈提纲：问题里不能有禁用词和疾病名称）。
   * 有问题时后端带着纠正说明重新生成一次，仍有问题就不保存草稿。
   */
  checkOutput?(output: z.output<S>, input?: SkillInput): WordingIssue[];
  /** 重新生成时附在用户消息后面的纠正说明。只按问题类别写，不复述上次的输出 */
  correctionNote?(issues: readonly WordingIssue[]): string;
}

/** 技能是否读取报告（必需或可选） */
export function skillUsesReport(skill: Pick<SkillDefinition, 'requiresReport' | 'usesReport'>) {
  return Boolean(skill.requiresReport || skill.usesReport);
}

/**
 * 多步计划（M2 规格 2.9、Q22）：只能在想一想模式下用，确认后按顺序调用多个技能，
 * 每个技能各出一份草稿。在 / 菜单里和技能一起列出。
 */
export interface PlanTemplate {
  id: string;
  skills: string[];
  /** 计划里先读取数字孪生（M4“孪生复盘”）；客户没有任何数据时不出计划 */
  readsTwin?: boolean;
  requiresClient: boolean;
  requiresReport: boolean;
  /** 同 SkillMeta.defaultRequest */
  defaultRequest: string | null;
}

/** 读取同目录下的 skill.md：--- 包起来的 key: value 元数据，加上正文提示词。 */
export function loadSkillMd(url: URL): { meta: Record<string, string>; body: string } {
  const text = readFileSync(url, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`skill.md 缺少元数据：${url.pathname}`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: (match[2] ?? '').trim() };
}

/** 把 skill.md 的元数据转成 SkillMeta，字段缺失或取值不对时直接报错。 */
export function parseSkillMeta(meta: Record<string, string>): SkillMeta {
  const bool = (key: string) => {
    if (meta[key] === 'true') return true;
    if (meta[key] === 'false') return false;
    throw new Error(`skill.md 字段 ${key} 必须是 true 或 false`);
  };
  const id = meta.id ?? '';
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error('skill.md 的 id 不合法');
  const modes = (meta.modes ?? '').split(',').map((m) => m.trim());
  if (!modes.length || modes.some((m) => !(SKILL_MODES as readonly string[]).includes(m))) {
    throw new Error('skill.md 的 modes 只能是 plan、craft');
  }
  if (!meta.kind) throw new Error('skill.md 缺少 kind');
  if (!meta.title) throw new Error('skill.md 缺少 title');
  // 面向客户的技能，标题会印在导出文件上，必须合规
  if (meta.clientFacing === 'true' && findBannedTerms(meta.title).length) {
    throw new Error('skill.md 的 title 含禁用词');
  }
  return {
    id,
    kind: meta.kind,
    title: meta.title,
    requiresClient: bool('requiresClient'),
    modes: modes as SkillMode[],
    clientFacing: bool('clientFacing'),
    involvesHealthJudgment: bool('involvesHealthJudgment'),
    defaultRequest: meta.defaultRequest?.trim() || null,
  };
}
