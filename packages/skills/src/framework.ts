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
import type { CriticalFlag } from '@health-buddy/shared';
import type { z } from 'zod';

export const SKILL_MODES = ['plan', 'craft'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export interface SkillMeta {
  id: string;
  /** 产物类型，写进 artifacts.kind */
  kind: string;
  requiresClient: boolean;
  modes: SkillMode[];
  /** 是否有给客户看的通俗版 */
  clientFacing: boolean;
  /** 是否涉及健康判断（涉及的产物必须审核，M1 所有产物都审核） */
  involvesHealthJudgment: boolean;
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
}

export interface SkillInput {
  client: ClientSnapshot;
  /** 健管师这次的要求（原话） */
  managerRequest: string;
  /** 退回重写时健管师填写的原因 */
  returnReason?: string | undefined;
}

/** 技能输出渲染后的产物内容。clientFacing 还没有拼接免责声明。 */
export interface SkillArtifact {
  professional: string;
  clientFacing: string;
  /** 健管师转述了心理危机信号，审核栏要醒目提示 */
  crisisSignal: boolean;
}

export interface SkillDefinition<S extends z.ZodType = z.ZodType> extends SkillMeta {
  /** 技能自己的提示词（skill.md 正文） */
  prompt: string;
  outputSchema: S;
  /** 把客户资料和健管师的要求组装成用户消息 */
  buildUserMessage(input: SkillInput): string;
  /** 把模型输出渲染成产物 */
  render(output: z.output<S>): SkillArtifact;
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
  return {
    id,
    kind: meta.kind,
    requiresClient: bool('requiresClient'),
    modes: modes as SkillMode[],
    clientFacing: bool('clientFacing'),
    involvesHealthJudgment: bool('involvesHealthJudgment'),
  };
}
