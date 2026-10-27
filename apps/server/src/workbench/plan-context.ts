import {
  addDaysIso,
  dateInTimeZone,
  renderGoal,
  scheduleVisits,
  visitRecordStructuredSchema,
  type CarePlanSnapshot,
  type Allergen,
  type ExerciseCategory,
  type GoalMetric,
  type GoalParam,
  type LibraryTag,
  type MealType,
  type PlanOptions,
  type PlanSection,
  type RiskTier,
  type VisitMethod,
} from '@health-buddy/shared';
import { selectPlanCandidates } from '@health-buddy/plan-library';
import type { PlanContext, PlanLibraryContext } from '@health-buddy/skills';
import type { TenantContext, TenantTransaction } from '../db/database.js';
import { dateText, managerTimeZone } from '../care/common.js';
import { visitFrequencyRulesIn } from '../plan-library/visit-frequency.repository.js';

/**
 * 方案和随访技能的上下文（M5 规格 5.2）：在当前健管师的租户上下文里读（行级安全决定可见范围）。
 * 方案只读生效的那一份的快照；随访记录只取最近 3 份的摘要和约定的事。只进内存，组装提示词前去标识。
 */

const RECENT_RECORDS = 3;

const TIER_LABEL = { high: '高', medium: '中', low: '低', none: '未分层' } as const;

export interface PlanContextOptions {
  /** /随访计划：按频次规则排出日期（Q17） */
  schedule: boolean;
  /**
   * /方案生成：读候选库条目和目标模板。allergyTexts 是健康史里过敏史的原文（只在内存里比对，Q16）；
   * restriction 是运动安全规则的原因类别（Q8）
   */
  library?: { options: PlanOptions; allergyTexts: string[]; restriction: string | null };
  /**
   * 想一想“方案和随访”（2.10）：同一次计划先生成的方案草稿的周期。方案复评按今天 + 周期排，
   * 不看正在执行的旧方案
   */
  draftCycleWeeks?: number;
  riskTier: RiskTier | null;
  /** 有 1、2 级未处理的跟进项（第一次随访不晚于 n 天） */
  hasUrgentFollowUp: boolean;
  tzFallback?: string | undefined;
  now?: Date;
}

export async function loadPlanContext(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
  options: PlanContextOptions,
): Promise<PlanContext> {
  const plan = await trx
    .selectFrom('care_plans')
    .select((eb) => [
      'snapshot',
      'sections',
      'cycle_weeks',
      dateText(eb, 'start_date').as('start_date_text'),
      dateText(eb, 'review_date').as('review_date_text'),
    ])
    .where('client_id', '=', clientId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  let currentPlan: PlanContext['currentPlan'] = null;
  if (plan) {
    const snapshot = plan.snapshot as CarePlanSnapshot;
    const goals = snapshot.structured.sections.flatMap((s) =>
      s.goals.map((g) => ({ section: s.section, ...g })),
    );
    const ids = [...new Set(goals.map((g) => g.templateId))];
    // 健管师只能读已发布的模板；以后停用的模板读不到，写“模板已停用”
    const templates = ids.length
      ? await trx
          .selectFrom('plan_goal_templates')
          .select(['id', 'text', 'params'])
          .where('id', 'in', ids)
          .execute()
      : [];
    const byId = new Map(templates.map((t) => [t.id, t]));
    currentPlan = {
      startDate: plan.start_date_text,
      reviewDate: plan.review_date_text,
      cycleWeeks: plan.cycle_weeks,
      sections: plan.sections as PlanSection[],
      goals: goals.map((g) => {
        const t = byId.get(g.templateId);
        let text = '（目标模板已停用）';
        if (t) {
          try {
            text = renderGoal({ text: t.text, params: t.params as GoalParam[] }, g.params);
          } catch {
            text = '（目标参数和模板对不上）';
          }
        }
        return { section: g.section, text };
      }),
    };
  }

  const records = await trx
    .selectFrom('visit_records')
    .select((eb) => ['snapshot', 'method', dateText(eb, 'visit_date').as('visit_date_text')])
    .where('client_id', '=', clientId)
    .orderBy('visit_date', 'desc')
    .orderBy('approved_at', 'desc')
    .limit(RECENT_RECORDS)
    .execute();
  const recentRecords = records.flatMap((r) => {
    const parsed = visitRecordStructuredSchema.safeParse(r.snapshot);
    if (!parsed.success) return [];
    return [
      {
        visitDate: r.visit_date_text,
        method: r.method as VisitMethod,
        summary: parsed.data.summary,
        agreements: parsed.data.agreements,
      },
    ];
  });

  const context: PlanContext = { currentPlan, recentRecords };
  if (options.library) context.library = await loadLibrary(trx, options.library);
  if (options.schedule) {
    const timeZone = await managerTimeZone(trx, ctx, options.tzFallback);
    const { rules } = await visitFrequencyRulesIn(trx);
    const now = options.now ?? new Date();
    const draftPlan =
      options.draftCycleWeeks === undefined
        ? undefined
        : {
            cycleWeeks: options.draftCycleWeeks,
            reviewDate: addDaysIso(dateInTimeZone(now, timeZone), options.draftCycleWeeks * 7),
          };
    const result = scheduleVisits({
      now,
      timeZone,
      riskTier: options.riskTier,
      rules,
      planReviewDate: draftPlan?.reviewDate ?? currentPlan?.reviewDate ?? null,
      hasUrgentFollowUp: options.hasUrgentFollowUp,
    });
    context.schedule = {
      today: result.today,
      tierLabel: TIER_LABEL[result.tier],
      intervalDays: result.intervalDays,
      rows: result.visits,
      ...(draftPlan ? { draftPlan } : {}),
    };
  }
  return context;
}

/**
 * 候选库条目（5.2）：只有健管师能看到的条目（已发布；预览环境含待审定，由行级安全和预览开关决定），
 * 筛选规则（过敏原排除、运动安全规则、按部分取目标模板）在 plan-library 里，评测共用。
 */
async function loadLibrary(
  trx: TenantTransaction,
  opts: NonNullable<PlanContextOptions['library']>,
): Promise<PlanLibraryContext> {
  const [recipeRows, exerciseRows, templateRows] = await Promise.all([
    trx
      .selectFrom('plan_library_recipes')
      .select([
        'id',
        'version',
        'name',
        'meal_types',
        'tags',
        'allergens',
        'ingredients',
        'steps',
        'nutrition_per_serving',
      ])
      .orderBy('code')
      .execute(),
    trx
      .selectFrom('plan_library_exercises')
      .select([
        'id',
        'version',
        'name',
        'category',
        'intensity',
        'steps',
        'key_points',
        'manager_cautions',
      ])
      .orderBy('code')
      .execute(),
    trx
      .selectFrom('plan_goal_templates')
      .select(['id', 'version', 'section', 'text', 'params', 'metric'])
      .orderBy('code')
      .execute(),
  ]);
  return selectPlanCandidates(
    {
      recipes: recipeRows.map((r) => ({
        id: r.id,
        version: r.version,
        name: r.name,
        mealTypes: r.meal_types as MealType[],
        tags: r.tags as LibraryTag[],
        allergens: r.allergens as Allergen[],
        ingredients: (r.ingredients as { name: string; householdAmount: string }[]).map((i) => ({
          name: i.name,
          householdAmount: i.householdAmount,
        })),
        steps: r.steps as string[],
        energyKcal: (r.nutrition_per_serving as { energyKcal?: number } | null)?.energyKcal ?? null,
      })),
      exercises: exerciseRows.map((e) => ({
        id: e.id,
        version: e.version,
        name: e.name,
        category: e.category as ExerciseCategory,
        intensity: e.intensity as 'low' | 'moderate',
        steps: e.steps as string[],
        keyPoints: e.key_points as string[],
        managerCautions: e.manager_cautions,
      })),
      goalTemplates: templateRows.map((t) => ({
        id: t.id,
        version: t.version,
        section: t.section as PlanSection,
        text: t.text,
        params: t.params as GoalParam[],
        metric: t.metric as GoalMetric | null,
      })),
    },
    opts,
  );
}
