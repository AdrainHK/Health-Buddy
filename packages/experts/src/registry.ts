/**
 * 专家注册表（M3 规格 4.1）：登记专家、负责的指标编码和健康史类别（规格 3.2 的规则路由用）。
 * 新专家用 /new-expert 新建目录后在这里登记。
 */
import type { ExpertProfile } from '@health-buddy/ai-engine';
import type { ExpertDetail, ExpertSummary } from '@health-buddy/shared';
import { cardioEvalCases } from './cardiovascular/evals/cases.js';
import { endocrineEvalCases } from './endocrine-metabolism/evals/cases.js';
import type { ExpertEvalCase } from './eval-types.js';
import { exerciseEvalCases } from './exercise-rehab/evals/cases.js';
import { loadExpert, sourcesPending, statusAllowed, type ExpertDefinition } from './framework.js';
import { labEvalCases } from './lab-interpretation/evals/cases.js';
import { mentalHealthEvalCases } from './mental-health/evals/cases.js';
import { nutritionEvalCases } from './nutrition/evals/cases.js';
import { EXPERT_RULES, cardsBlock } from './rules.js';

const cardRefs = (cases: readonly ExpertEvalCase[]) =>
  cases.flatMap((c) => c.expect.citedCards ?? []);

const load = (id: string, cases: readonly ExpertEvalCase[]) =>
  loadExpert(new URL(`./${id}/`, import.meta.url), cardRefs(cases));

/** 注册表顺序也是规则路由同分时的先后顺序 */
export const EXPERTS: readonly ExpertDefinition[] = [
  load('endocrine-metabolism', endocrineEvalCases),
  load('cardiovascular', cardioEvalCases),
  load('nutrition', nutritionEvalCases),
  load('exercise-rehab', exerciseEvalCases),
  load('mental-health', mentalHealthEvalCases),
  load('lab-interpretation', labEvalCases),
];

export const EXPERT_EVAL_CASES: Record<string, readonly ExpertEvalCase[]> = {
  'endocrine-metabolism': endocrineEvalCases,
  cardiovascular: cardioEvalCases,
  nutrition: nutritionEvalCases,
  'exercise-rehab': exerciseEvalCases,
  'mental-health': mentalHealthEvalCases,
  'lab-interpretation': labEvalCases,
};

export function getExpert(id: string): ExpertDefinition | undefined {
  return EXPERTS.find((e) => e.meta.id === id);
}

/** 专家的中文名；不认识的 id 原样返回（历史记录里可能有已下架的专家） */
export function expertName(id: string): string {
  return getExpert(id)?.meta.name ?? id;
}

export interface Availability {
  /** 预览环境：放行 review 状态和“待确认”卡片（Q2） */
  preview: boolean;
  /** 平台暂停的专家（Q11） */
  paused: ReadonlySet<string>;
}

export function isAvailable(def: ExpertDefinition, env: Availability): boolean {
  return statusAllowed(def.meta.status, env.preview) && !env.paused.has(def.meta.id);
}

/** 当前账号可用的专家（专家库、@ 列表、路由候选） */
export function availableExperts(env: Availability): ExpertDefinition[] {
  return EXPERTS.filter((e) => isAvailable(e, env));
}

/**
 * 给引擎用的专家定义。正式环境只能引用已确认的卡片；预览环境也能引用待确认的卡片（规格 5.2 第 1 条）。
 * 系统提示词：共用规则 + expert.md 正文 + 条目卡片，不变的部分在前（规格 3.7）。
 */
export function toProfile(
  def: ExpertDefinition,
  env: Pick<Availability, 'preview'>,
): ExpertProfile {
  const cards = def.sources.cards.filter((c) => c.confirmed || env.preview);
  return {
    id: def.meta.id,
    name: def.meta.name,
    version: def.meta.version,
    sourcesVersion: def.sources.version,
    indicatorCodes: def.meta.indicatorCodes,
    historyCategories: def.meta.historyCategories,
    maxOutputTokens: def.meta.maxOutputTokens,
    systemPrompt: `${EXPERT_RULES}\n\n---\n\n${def.prompt}\n\n---\n\n${cardsBlock(cards)}`,
    catalog: { tagline: def.meta.tagline, strengths: def.strengths, outOfScope: def.outOfScope },
    cards: cards.map((c) => ({ cardId: c.cardId, sourceId: c.sourceId, numbers: c.numbers })),
  };
}

export function expertSummary(def: ExpertDefinition, env: Availability): ExpertSummary {
  return {
    id: def.meta.id,
    name: def.meta.name,
    tagline: def.meta.tagline,
    version: def.meta.version,
    status: def.meta.status,
    available: isAvailable(def, env),
    sourcesPending: sourcesPending(def),
  };
}

/** 专家详情。未确认来源的版本年份不显示（规格 5.2 第 4 条） */
export function expertDetail(
  def: ExpertDefinition,
  env: Availability,
  myUsageCount: number,
): ExpertDetail {
  const visibleCards = def.sources.cards.filter((c) => c.confirmed || env.preview);
  return {
    ...expertSummary(def, env),
    strengths: def.strengths,
    outOfScope: def.outOfScope,
    sources: def.sources.sources
      .filter((s) => s.status !== 'retired')
      .map((s) => ({
        sourceId: s.sourceId,
        name: s.name,
        publisher: s.status === 'confirmed' ? s.publisher : null,
        version: s.status === 'confirmed' ? s.version : null,
        status: s.status,
      })),
    cards: visibleCards.map((c) => ({
      cardId: c.cardId,
      sourceId: c.sourceId,
      section: c.section,
      point: c.point,
      confirmed: c.confirmed,
    })),
    myUsageCount,
  };
}
