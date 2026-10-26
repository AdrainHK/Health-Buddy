import { z } from 'zod';
import {
  goalMetricSchema,
  goalParamValuesSchema,
  libraryItemTypeSchema,
  mealTypeSchema,
  planSectionSchema,
} from '../plan/library.js';

/**
 * 方案（M5 规格 2.2、2.3、2.6、6.3）。
 * 方案是 AI 草稿，健管师确认后才生效（写入 care_plans，红线 3）。专业版只给健管师；
 * 通俗版审核后才能复制或导出给客户，免责声明由后端拼接。执行情况只给健管师看。
 */

/** M5 新增的产物类型 */
export const M5_ARTIFACT_KINDS = [
  'care_plan',
  'visit_schedule',
  'visit_script',
  'visit_record',
] as const;
export type M5ArtifactKind = (typeof M5_ARTIFACT_KINDS)[number];

/** 方案周期（Q2）：4、8（默认）、12 周 */
export const CARE_PLAN_CYCLE_WEEKS = [4, 8, 12] as const;
export const DEFAULT_CARE_PLAN_CYCLE_WEEKS = 8;
export const carePlanCycleWeeksSchema = z.union([z.literal(4), z.literal(8), z.literal(12)]);
export type CarePlanCycleWeeks = z.infer<typeof carePlanCycleWeeksSchema>;

const sectionsSchema = z
  .array(planSectionSchema)
  .min(1)
  .max(4)
  .refine((v) => new Set(v).size === v.length, { message: 'duplicate section' });

/** 方案选项条（2.2）：包含哪几部分（默认全选，至少一个）、周期 */
export const planOptionsSchema = z.object({
  sections: sectionsSchema.default(['diet', 'exercise', 'routine', 'mind']),
  cycleWeeks: carePlanCycleWeeksSchema.default(DEFAULT_CARE_PLAN_CYCLE_WEEKS),
});
export type PlanOptions = z.infer<typeof planOptionsSchema>;

export const CARE_PLAN_GOALS_PER_SECTION_MAX = 6;
export const CARE_PLAN_RECIPES_MAX = 28;
export const CARE_PLAN_EXERCISES_MAX = 12;
export const CARE_PLAN_SECTION_TEXT_MAX = 6000;

/** 行为目标：只能从目标模板选，参数在模板范围内（Q3，后端按模板再校验） */
export const carePlanGoalSchema = z.object({
  templateId: z.uuid(),
  params: goalParamValuesSchema,
});
export type CarePlanGoal = z.infer<typeof carePlanGoalSchema>;

/** 示例一周食谱：第几天、哪一餐、库条目 id（Q15：只能引用库条目，由后端渲染） */
export const carePlanRecipeSchema = z.object({
  day: z.number().int().min(1).max(7),
  meal: mealTypeSchema,
  recipeId: z.uuid(),
});

/** 运动或放松练习：库条目 id、每周几次、每次几分钟（在库条目和目标模板允许的范围内） */
export const carePlanExerciseSchema = z.object({
  exerciseId: z.uuid(),
  frequencyPerWeek: z.number().int().min(1).max(7),
  minutes: z.number().int().min(1).max(120),
});

export const carePlanSectionSchema = z.object({
  section: planSectionSchema,
  /** 专业版这一部分的文字 */
  professional: z.string().max(CARE_PLAN_SECTION_TEXT_MAX),
  /** 通俗版这一部分的文字（库条目段落由后端渲染后拼接） */
  clientFacing: z.string().max(CARE_PLAN_SECTION_TEXT_MAX),
  goals: z.array(carePlanGoalSchema).max(CARE_PLAN_GOALS_PER_SECTION_MAX),
});

/**
 * 方案草稿的结构化内容（artifacts.structured，kind = care_plan）。
 * 食谱只能出现在饮食部分；运动条目只能出现在运动或心理（放松练习）部分。
 */
export const carePlanStructuredSchema = z
  .object({
    sections: z
      .array(carePlanSectionSchema)
      .min(1)
      .max(4)
      .refine((v) => new Set(v.map((s) => s.section)).size === v.length, {
        message: 'duplicate section',
      }),
    recipes: z.array(carePlanRecipeSchema).max(CARE_PLAN_RECIPES_MAX).default([]),
    exercises: z.array(carePlanExerciseSchema).max(CARE_PLAN_EXERCISES_MAX).default([]),
  })
  .refine((v) => v.recipes.length === 0 || v.sections.some((s) => s.section === 'diet'), {
    message: 'recipes need the diet section',
    path: ['recipes'],
  })
  .refine(
    (v) =>
      v.exercises.length === 0 ||
      v.sections.some((s) => s.section === 'exercise' || s.section === 'mind'),
    { message: 'exercises need the exercise or mind section', path: ['exercises'] },
  )
  .refine((v) => new Set(v.recipes.map((r) => `${r.day}:${r.meal}`)).size === v.recipes.length, {
    message: 'one recipe per meal',
    path: ['recipes'],
  });
export type CarePlanStructured = z.infer<typeof carePlanStructuredSchema>;

/** 方案快照：确认那一刻的全文和引用的库条目版本（库条目以后改了，已生效的方案内容不变） */
export const carePlanSnapshotSchema = z.object({
  structured: carePlanStructuredSchema,
  content: z.object({ professional: z.string(), clientFacing: z.string() }),
  libraryVersions: z.array(
    z.object({ type: libraryItemTypeSchema, id: z.uuid(), version: z.number().int().positive() }),
  ),
});
export type CarePlanSnapshot = z.infer<typeof carePlanSnapshotSchema>;

export const CARE_PLAN_STATUSES = ['active', 'ended', 'superseded'] as const;
export const carePlanStatusSchema = z.enum(CARE_PLAN_STATUSES);
export type CarePlanStatus = z.infer<typeof carePlanStatusSchema>;

/** 结束方案的原因：周期结束、客户要求暂停、需要先就医评估、其他 */
export const CARE_PLAN_END_REASONS = [
  'cycle_completed',
  'client_paused',
  'needs_medical_review',
  'other',
] as const;
export const carePlanEndReasonSchema = z.enum(CARE_PLAN_END_REASONS);

export const carePlanSummarySchema = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  /** 确认的那一版产物；客户转出后为空（产物按 M1 Q11 作废，快照保留） */
  artifactId: z.uuid().nullable(),
  sections: z.array(planSectionSchema),
  cycleWeeks: carePlanCycleWeeksSchema,
  startDate: z.iso.date(),
  reviewDate: z.iso.date(),
  status: carePlanStatusSchema,
  endReason: carePlanEndReasonSchema.nullable(),
  approvedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type CarePlanSummary = z.infer<typeof carePlanSummarySchema>;

/** 生效方案（含快照全文），只给服务这位客户的健管师 */
export const carePlanSchema = carePlanSummarySchema.extend({ snapshot: carePlanSnapshotSchema });
export type CarePlan = z.infer<typeof carePlanSchema>;

export const carePlanListResponseSchema = z.object({
  current: carePlanSummarySchema.nullable(),
  /** 已被替代和已结束的方案，按生效时间倒序 */
  history: z.array(carePlanSummarySchema),
});
export type CarePlanListResponse = z.infer<typeof carePlanListResponseSchema>;

export const carePlanResponseSchema = z.object({ plan: carePlanSchema });
export type CarePlanResponse = z.infer<typeof carePlanResponseSchema>;

/** POST /api/care-plans/:id/end：原因必填 */
export const endCarePlanRequestSchema = z.object({ reason: carePlanEndReasonSchema });
export type EndCarePlanRequest = z.infer<typeof endCarePlanRequestSchema>;

/** 执行情况（2.6、Q10）。只给健管师看，不进通俗版 */
export const adherenceResponseSchema = z.object({
  planId: z.uuid(),
  /** 按健管师时区的今天 */
  asOf: z.iso.date(),
  timeZone: z.string(),
  /** 关联了监测指标的目标 */
  goals: z.array(
    z.object({
      templateId: z.uuid(),
      metric: goalMetricSchema,
      target: z.number(),
      hasData: z.boolean(),
      windows: z.array(
        z.object({
          days: z.union([z.literal(7), z.literal(14)]),
          daysWithData: z.number().int().nonnegative(),
          average: z.number().nullable(),
          daysMet: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  /** 没有关联监测指标的目标：界面显示“需在随访时了解” */
  untrackedTemplateIds: z.array(z.uuid()),
});
export type AdherenceResponse = z.infer<typeof adherenceResponseSchema>;
