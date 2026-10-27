import { allergenConflicts, type PlanOptions } from '@health-buddy/shared';
import type {
  ClientSnapshot,
  ExerciseCandidate,
  GoalTemplateCandidate,
  PlanLibraryContext,
  RecipeCandidate,
} from '@health-buddy/skills';
import type { PlanLibrarySeed } from './seed.js';

/** 每类候选不超过 40 条（M5 规格 5.2）：食谱按餐次各取，动作取前 40 条 */
export const CANDIDATES_MAX = 40;

export interface CandidatePool {
  recipes: RecipeCandidate[];
  exercises: ExerciseCandidate[];
  goalTemplates: GoalTemplateCandidate[];
}

export interface CandidateOptions {
  options: PlanOptions;
  /** 健康史里过敏史的原文，只在内存里比对（Q16） */
  allergyTexts: readonly string[];
  /** 运动安全规则的原因类别（Q8）；不限制时为 null */
  restriction: string | null;
}

/**
 * /方案生成 的候选库条目（5.2）。pool 是健管师能看到的全部条目（按 code 排好序）：
 * 食谱先按过敏史排除（Q16），运动安全规则限制时只留放松练习、不给运动目标（Q8），
 * 目标模板只取选中的部分。后端和评测共用这一套筛选。
 */
export function selectPlanCandidates(
  pool: CandidatePool,
  opts: CandidateOptions,
): PlanLibraryContext {
  const sections = opts.options.sections;
  const recipePool = sections.includes('diet') ? pool.recipes : [];
  const conflicts = new Set(allergenConflicts(opts.allergyTexts, recipePool).map((c) => c.itemId));
  const perMeal = new Map<string, number>();
  const recipes = recipePool
    .filter((r) => !conflicts.has(r.id))
    .filter((r) => {
      // 每个餐次最多 40 条：至少有一个餐次还没满就收下
      if (!r.mealTypes.some((m) => (perMeal.get(m) ?? 0) < CANDIDATES_MAX)) return false;
      for (const m of r.mealTypes) perMeal.set(m, (perMeal.get(m) ?? 0) + 1);
      return true;
    });

  const wantsMoves = sections.includes('exercise') || sections.includes('mind');
  const exercises = (wantsMoves ? pool.exercises : [])
    .filter((e) => {
      const relaxation = e.category === 'relaxation';
      // 运动安全规则：不给运动动作，只留心理部分的放松练习
      if (opts.restriction && !relaxation) return false;
      return relaxation || sections.includes('exercise');
    })
    .slice(0, CANDIDATES_MAX);

  const goalTemplates = pool.goalTemplates.filter(
    (t) =>
      sections.includes(t.section) &&
      // 运动安全规则：运动部分不设运动目标
      !(opts.restriction && t.section === 'exercise'),
  );

  return {
    options: opts.options,
    recipes,
    exercises,
    goalTemplates,
    excludedForAllergy: conflicts.size,
    exerciseRestriction: opts.restriction,
    libraryEmpty:
      pool.recipes.length === 0 && pool.exercises.length === 0 && pool.goalTemplates.length === 0,
  };
}

/** 生成前识别到急症信号时补上运动安全规则（Q8）：去掉运动动作和运动目标，只留放松练习 */
export function restrictExercise(lib: PlanLibraryContext, reason: string): PlanLibraryContext {
  return {
    ...lib,
    exercises: lib.exercises.filter((e) => e.category === 'relaxation'),
    goalTemplates: lib.goalTemplates.filter((t) => t.section !== 'exercise'),
    exerciseRestriction: reason,
  };
}

/** 种子内容换成候选（评测用；id 用 code，版本为 1） */
export function seedCandidatePool(seed: PlanLibrarySeed): CandidatePool {
  return {
    recipes: seed.recipes.map((r) => ({
      id: r.code,
      version: 1,
      name: r.name,
      mealTypes: [...r.mealTypes],
      tags: [...r.tags],
      allergens: [...r.allergens],
      ingredients: r.ingredients.map((i) => ({ name: i.name, householdAmount: i.householdAmount })),
      steps: [...r.steps],
      energyKcal: r.nutritionPerServing?.energyKcal ?? null,
    })),
    exercises: seed.exercises.map((e) => ({
      id: e.code,
      version: 1,
      name: e.name,
      category: e.category,
      intensity: e.intensity,
      steps: [...e.steps],
      keyPoints: [...e.keyPoints],
      managerCautions: e.managerCautions,
    })),
    goalTemplates: seed.goalTemplates.map((t) => ({
      id: t.code,
      version: 1,
      section: t.section,
      text: t.text,
      params: t.params,
      metric: t.metric,
    })),
  };
}

/**
 * 运动安全规则（Q8）用的健康史关键词：心脏病、近期手术、严重骨关节病。只用来决定运动部分写不写动作，
 * 不进提示词原文（原因只写类别）
 */
const EXERCISE_RISK_HISTORY =
  /心脏病|冠心病|心梗|心肌梗|心绞痛|心衰|心力衰竭|心律失常|房颤|支架|搭桥|起搏器|瓣膜|近期手术|术后|手术后|刚做完手术|骨折|关节置换|严重骨关节|椎间盘突出|半月板/;

/**
 * 运动安全规则（Q8）：有危急指标，或健康史里有心脏、近期手术、严重骨关节相关的记录时，返回原因类别；
 * 急症信号在生成服务里识别后另外加上。不限制时返回 null
 */
export function exerciseRestriction(snapshot: ClientSnapshot): string | null {
  if (snapshot.criticalFlags.length) return '有危急指标';
  const history = (snapshot.healthHistory ?? []).filter(
    (h) =>
      h.category === 'past_history' || h.category === 'medication' || h.category === 'lifestyle',
  );
  if (history.some((h) => EXERCISE_RISK_HISTORY.test(h.content))) {
    return '健康史里有心脏、近期手术或骨关节相关的记录';
  }
  return null;
}

/** 健康史里过敏史的原文（只在内存里和库条目比对，不进日志，Q16） */
export function allergyTextsOf(snapshot: ClientSnapshot): string[] {
  return (snapshot.healthHistory ?? [])
    .filter((h) => h.category === 'allergy')
    .map((h) => h.content);
}
