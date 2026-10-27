import { z } from 'zod';

/**
 * 方案库：食谱、运动和放松练习、方案目标模板（M5 规格 2.4、第四节、6.2）。
 * 平台级数据（没有租户列），平台管理员维护；只有“已发布”的条目能被方案引用。
 * 种子内容和参数范围都是候选，待营养、运动顾问审定。
 */

/** 条目状态，同专家的 status：草稿 → 待审定 → 已发布 → 已停用 */
export const LIBRARY_ITEM_STATUSES = ['draft', 'review', 'published', 'retired'] as const;
export const libraryItemStatusSchema = z.enum(LIBRARY_ITEM_STATUSES);
export type LibraryItemStatus = z.infer<typeof libraryItemStatusSchema>;

/**
 * 状态只能按顺序流转（数据库触发器同样约束）。内容只能在草稿状态下修改：已发布或已停用的条目
 * 要改内容，先退回草稿（审定信息随之清空），再送审、发布。
 */
export const LIBRARY_STATUS_TRANSITIONS: Record<LibraryItemStatus, readonly LibraryItemStatus[]> = {
  draft: ['review'],
  review: ['draft', 'published'],
  published: ['draft', 'retired'],
  retired: ['draft'],
};

export const LIBRARY_ITEM_TYPES = ['recipe', 'exercise', 'goal_template'] as const;
export const libraryItemTypeSchema = z.enum(LIBRARY_ITEM_TYPES);
export type LibraryItemType = z.infer<typeof libraryItemTypeSchema>;

/** 方案的四个部分：饮食、运动、作息、心理（Q1） */
export const PLAN_SECTIONS = ['diet', 'exercise', 'routine', 'mind'] as const;
export const planSectionSchema = z.enum(PLAN_SECTIONS);
export type PlanSection = z.infer<typeof planSectionSchema>;

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export const mealTypeSchema = z.enum(MEAL_TYPES);
export type MealType = z.infer<typeof mealTypeSchema>;

/**
 * 食谱的特点标签（固定标签表）。只描述食物本身，不写和疾病、功效挂钩的标签（4.2）。
 * 名称走 i18n（planLibrary.tags.<code>）。
 */
export const LIBRARY_TAGS = [
  'low_oil',
  'low_salt',
  'high_fiber',
  'quality_protein',
  'mixed_grains',
  'vegetable_rich',
  'low_sugar',
  'quick',
  'vegetarian',
] as const;
export const libraryTagSchema = z.enum(LIBRARY_TAGS);
export type LibraryTag = z.infer<typeof libraryTagSchema>;

/**
 * 过敏原标签（Q16）：花生、坚果、乳制品、蛋、海鲜、大豆、麸质、芝麻
 * （芝麻由产品负责人 2026-10-27 确认加入；陈醋、香醋里的麸质不单独标）
 */
export const ALLERGENS = [
  'peanut',
  'tree_nut',
  'dairy',
  'egg',
  'seafood',
  'soy',
  'gluten',
  'sesame',
] as const;
export const allergenSchema = z.enum(ALLERGENS);
export type Allergen = z.infer<typeof allergenSchema>;

export const EXERCISE_CATEGORIES = [
  'aerobic',
  'strength',
  'flexibility',
  'balance',
  'relaxation',
] as const;
export const exerciseCategorySchema = z.enum(EXERCISE_CATEGORIES);
export type ExerciseCategory = z.infer<typeof exerciseCategorySchema>;

export const EXERCISE_INTENSITIES = ['low', 'moderate'] as const;
export const exerciseIntensitySchema = z.enum(EXERCISE_INTENSITIES);

export const EXERCISE_SETTINGS = ['home', 'outdoor', 'gym'] as const;
export const exerciseSettingSchema = z.enum(EXERCISE_SETTINGS);

/** 目标模板对应的监测指标（执行情况，2.6、Q10）；M5 只有步数和睡眠时长 */
export const GOAL_METRICS = ['steps', 'sleep_hours'] as const;
export const goalMetricSchema = z.enum(GOAL_METRICS);
export type GoalMetric = z.infer<typeof goalMetricSchema>;

export const LIBRARY_NAME_MAX = 60;
export const LIBRARY_TEXT_MAX = 500;
export const LIBRARY_LIST_MAX = 20;
export const LIBRARY_SOURCE_MAX = 300;
export const LIBRARY_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

const codeSchema = z.string().regex(LIBRARY_CODE_PATTERN);
const nameSchema = z.string().trim().min(1).max(LIBRARY_NAME_MAX);
const textSchema = z.string().trim().min(1).max(LIBRARY_TEXT_MAX);
const textListSchema = z.array(textSchema).min(1).max(LIBRARY_LIST_MAX);
const sourceNoteSchema = z.string().trim().min(1).max(LIBRARY_SOURCE_MAX);

function uniqueArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine((v) => new Set(v).size === v.length, { message: 'duplicate value' });
}

// ---------- 食谱 ----------

export const recipeIngredientSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** 家庭常用量，如“一拳”“半碗”（Q4） */
  householdAmount: z.string().trim().min(1).max(40),
  /** 参考克数，可空 */
  grams: z.number().positive().max(2000).nullable().default(null),
  /** 海外常见替代食材（Q14），如“芥蓝 → 西兰花” */
  overseasAlternative: z.string().trim().min(1).max(60).nullable().default(null),
});

/** 每份的能量和主要营养素（标明计算依据和版本，Q13）。只给健管师比较食谱用 */
export const nutritionPerServingSchema = z.object({
  energyKcal: z.number().nonnegative().max(3000),
  proteinG: z.number().nonnegative().max(300),
  fatG: z.number().nonnegative().max(300),
  carbG: z.number().nonnegative().max(500),
  fiberG: z.number().nonnegative().max(100),
  sodiumMg: z.number().nonnegative().max(10000),
});

/** 食谱内容（新增、修改和种子文件共用）。面向客户的文字由后端再过禁用词和措辞检查 */
export const recipeContentSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    mealTypes: uniqueArray(mealTypeSchema, MEAL_TYPES.length).min(1),
    ingredients: z.array(recipeIngredientSchema).min(1).max(LIBRARY_LIST_MAX),
    steps: textListSchema,
    nutritionPerServing: nutritionPerServingSchema.nullable(),
    nutritionBasis: z.string().trim().min(1).max(LIBRARY_SOURCE_MAX).nullable(),
    tags: uniqueArray(libraryTagSchema, LIBRARY_TAGS.length),
    /** 必须显式填写，可以为空数组（4.2） */
    allergens: uniqueArray(allergenSchema, ALLERGENS.length),
    sourceNote: sourceNoteSchema,
  })
  // 标了营养数据就必须写计算依据
  .refine((v) => v.nutritionPerServing === null || v.nutritionBasis !== null, {
    message: 'nutrition needs its basis',
    path: ['nutritionBasis'],
  });
export type RecipeContent = z.infer<typeof recipeContentSchema>;

// ---------- 运动和放松练习 ----------

export const exerciseContentSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  category: exerciseCategorySchema,
  intensity: exerciseIntensitySchema,
  setting: uniqueArray(exerciseSettingSchema, EXERCISE_SETTINGS.length).min(1),
  /** 器材（如“弹力带”“椅子”）；无器材为空数组。不写品牌 */
  equipment: uniqueArray(z.string().trim().min(1).max(30), 10),
  steps: textListSchema,
  keyPoints: textListSchema,
  commonMistakes: z.array(textSchema).max(LIBRARY_LIST_MAX),
  /** 给健管师看的注意事项（哪些情况先问医生），必填，通俗版和客户端都不显示（4.2） */
  managerCautions: textSchema,
  /** 参考 MET 值，可空 */
  met: z.number().positive().max(20).nullable(),
  sourceNote: sourceNoteSchema,
});
export type ExerciseContent = z.infer<typeof exerciseContentSchema>;

// ---------- 目标模板 ----------

/** 时间参数：HH:MM，允许 24:00 表示午夜（如“每晚 24:00 前上床”） */
export const GOAL_TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const goalTimeSchema = z.string().regex(GOAL_TIME_PATTERN);
const paramNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export function goalTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export const goalParamSchema = z.discriminatedUnion('type', [
  z.object({
    name: paramNameSchema,
    type: z.literal('int'),
    min: z.number().int(),
    max: z.number().int(),
    default: z.number().int(),
    /** 单位，如“步”“分钟”；只用于界面显示 */
    unit: z.string().trim().min(1).max(10).nullable().default(null),
  }),
  z.object({
    name: paramNameSchema,
    type: z.literal('time'),
    min: goalTimeSchema,
    max: goalTimeSchema,
    default: goalTimeSchema,
  }),
]);
export type GoalParam = z.infer<typeof goalParamSchema>;

/** 目标参数的取值：整数或 HH:MM */
export type GoalParamValues = Record<string, number | string>;
export const goalParamValuesSchema = z.record(
  paramNameSchema,
  z.union([z.number().int(), goalTimeSchema]),
);

export const GOAL_TEMPLATE_TEXT_MAX = 100;
export const GOAL_PARAMS_MAX = 3;
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,31})\}/g;

/** 模板文字里的占位符名，按出现顺序 */
export function goalPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

export interface GoalTemplateShape {
  text: string;
  params: readonly GoalParam[];
  metric: GoalMetric | null;
  metricParam: string | null;
}

/**
 * 模板形状检查：占位符和参数一一对应、范围合理、默认值在范围内；
 * 关联了监测指标时必须指明哪个整数参数是目标值。返回错误说明，没问题返回 null。
 */
export function goalTemplateShapeError(t: GoalTemplateShape): string | null {
  const placeholders = goalPlaceholders(t.text);
  const names = t.params.map((p) => p.name);
  if (new Set(names).size !== names.length) return 'duplicate param';
  if (new Set(placeholders).size !== placeholders.length) return 'duplicate placeholder';
  if (placeholders.length !== names.length || placeholders.some((p) => !names.includes(p))) {
    return 'placeholders must match params';
  }
  if (/[{}]/.test(t.text.replace(PLACEHOLDER, ''))) return 'stray brace';
  for (const p of t.params) {
    const [min, max, def] =
      p.type === 'int'
        ? [p.min, p.max, p.default]
        : [goalTimeToMinutes(p.min), goalTimeToMinutes(p.max), goalTimeToMinutes(p.default)];
    if (min > max) return `param ${p.name}: min > max`;
    if (def < min || def > max) return `param ${p.name}: default out of range`;
  }
  if ((t.metric === null) !== (t.metricParam === null)) return 'metric and metricParam go together';
  if (t.metricParam !== null) {
    const target = t.params.find((p) => p.name === t.metricParam);
    if (!target || target.type !== 'int') return 'metricParam must be an int param';
  }
  return null;
}

export const goalTemplateContentSchema = z
  .object({
    code: codeSchema,
    section: planSectionSchema,
    /** 含 {param} 占位，如“每天步行 {steps} 步” */
    text: z.string().trim().min(1).max(GOAL_TEMPLATE_TEXT_MAX),
    params: z.array(goalParamSchema).max(GOAL_PARAMS_MAX),
    /** 对应的监测指标（执行情况用），可空 */
    metric: goalMetricSchema.nullable(),
    /** 哪个参数是监测指标的目标值（metric 不为空时必填） */
    metricParam: paramNameSchema.nullable(),
    sourceNote: sourceNoteSchema,
  })
  .superRefine((v, ctx) => {
    const error = goalTemplateShapeError(v);
    if (error) ctx.addIssue({ code: 'custom', message: error });
  });
export type GoalTemplateContent = z.infer<typeof goalTemplateContentSchema>;

export interface GoalParamIssue {
  param: string;
  reason: 'missing' | 'unknown' | 'wrong_type' | 'out_of_range';
}

/**
 * 校验目标参数（2.3：只能在模板范围内，超出范围前后端都拒绝）。
 * 缺少的参数不补默认值（由调用方决定是否用默认值），多余的参数也算错。
 */
export function validateGoalParams(
  params: readonly GoalParam[],
  values: Readonly<Record<string, unknown>>,
): GoalParamIssue[] {
  const issues: GoalParamIssue[] = [];
  for (const key of Object.keys(values)) {
    if (!params.some((p) => p.name === key)) issues.push({ param: key, reason: 'unknown' });
  }
  for (const p of params) {
    if (!Object.hasOwn(values, p.name)) {
      issues.push({ param: p.name, reason: 'missing' });
      continue;
    }
    const v = values[p.name];
    if (p.type === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        issues.push({ param: p.name, reason: 'wrong_type' });
      } else if (v < p.min || v > p.max) {
        issues.push({ param: p.name, reason: 'out_of_range' });
      }
    } else if (typeof v !== 'string' || !GOAL_TIME_PATTERN.test(v)) {
      issues.push({ param: p.name, reason: 'wrong_type' });
    } else {
      const m = goalTimeToMinutes(v);
      if (m < goalTimeToMinutes(p.min) || m > goalTimeToMinutes(p.max)) {
        issues.push({ param: p.name, reason: 'out_of_range' });
      }
    }
  }
  return issues;
}

/** 模板的默认参数 */
export function defaultGoalParams(params: readonly GoalParam[]): GoalParamValues {
  return Object.fromEntries(params.map((p) => [p.name, p.default]));
}

export class GoalParamError extends Error {
  constructor(readonly issues: GoalParamIssue[]) {
    super('invalid goal params');
    this.name = 'GoalParamError';
  }
}

/**
 * 模板 + 参数 → 文字（后端确定性渲染，2.3、3.2）。参数不合格时抛 GoalParamError，
 * 不会渲染出超范围的目标。
 */
export function renderGoal(
  template: Pick<GoalTemplateShape, 'text' | 'params'>,
  values: Readonly<Record<string, unknown>>,
): string {
  const issues = validateGoalParams(template.params, values);
  if (issues.length) throw new GoalParamError(issues);
  return template.text.replace(PLACEHOLDER, (_, name: string) => String(values[name]));
}

// ---------- 记录（列表、详情） ----------

/** 平台管理员和审定相关的字段（后台用） */
const adminMeta = {
  id: z.uuid(),
  status: libraryItemStatusSchema,
  version: z.number().int().positive(),
  reviewedByLabel: z.string().nullable(),
  reviewedOn: z.iso.date().nullable(),
  /** 最后修改人的显示名；只有平台管理员能看到（其他后台角色为 null） */
  updatedByName: z.string().nullable(),
  updatedAt: z.iso.datetime(),
};

/** 健管师看到的条目：只有已发布（预览环境含待审定），不含审定信息 */
const managerMeta = {
  id: z.uuid(),
  version: z.number().int().positive(),
};

const recipeFields = recipeContentSchema.shape;
const goalFields = goalTemplateContentSchema.shape;

/** 后台（平台、协会、机构管理员）看到的食谱 */
export const recipeSchema = z.object({ ...recipeFields, ...adminMeta });
export type Recipe = z.infer<typeof recipeSchema>;
/** 健管师看到的食谱 */
export const recipeManagerSchema = z.object({ ...recipeFields, ...managerMeta });
export type RecipeManagerView = z.infer<typeof recipeManagerSchema>;

export const exerciseSchema = z.object({ ...exerciseContentSchema.shape, ...adminMeta });
export type Exercise = z.infer<typeof exerciseSchema>;
/** 健管师看到的运动条目，含“给健管师看的注意事项” */
export const exerciseManagerSchema = z.object({ ...exerciseContentSchema.shape, ...managerMeta });
export type ExerciseManagerView = z.infer<typeof exerciseManagerSchema>;
/**
 * 以后客户端（M6）用的第三个 schema：不含 managerCautions，也不含 sourceNote
 * （来源说明只查禁用词，可能写着共识文件名里的疾病名称）
 */
export const exerciseClientSchema = exerciseManagerSchema.omit({
  managerCautions: true,
  sourceNote: true,
});
export type ExerciseClientView = z.infer<typeof exerciseClientSchema>;

export const goalTemplateSchema = z.object({ ...goalFields, ...adminMeta });
export type GoalTemplate = z.infer<typeof goalTemplateSchema>;
export const goalTemplateManagerSchema = z.object({ ...goalFields, ...managerMeta });
export type GoalTemplateManagerView = z.infer<typeof goalTemplateManagerSchema>;
