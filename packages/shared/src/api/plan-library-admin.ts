import { z } from 'zod';
import {
  exerciseCategorySchema,
  exerciseContentSchema,
  exerciseIntensitySchema,
  exerciseManagerSchema,
  exerciseSchema,
  goalTemplateContentSchema,
  goalTemplateManagerSchema,
  goalTemplateSchema,
  libraryItemStatusSchema,
  libraryTagSchema,
  mealTypeSchema,
  planSectionSchema,
  recipeContentSchema,
  recipeManagerSchema,
  recipeSchema,
} from '../plan/library.js';

/**
 * 方案库的接口（M5 规格 2.4、2.12、6.4）。
 * 健管师只读已发布条目（预览开关打开时含待审定）；平台管理员维护；协会、机构管理员只读。
 * 条目内容是面向客户的文字，保存时后端过禁用词和措辞检查，不合格返回 400 并标出位置。
 */

export const recipeListQuerySchema = z.object({
  meal: mealTypeSchema.optional(),
  tags: z
    .union([libraryTagSchema, z.array(libraryTagSchema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  q: z.string().trim().max(40).optional(),
});
export const exerciseListQuerySchema = z.object({
  category: exerciseCategorySchema.optional(),
  intensity: exerciseIntensitySchema.optional(),
  q: z.string().trim().max(40).optional(),
});
export const goalTemplateListQuerySchema = z.object({ section: planSectionSchema.optional() });

export const recipeListResponseSchema = z.object({ items: z.array(recipeManagerSchema) });
export const exerciseListResponseSchema = z.object({ items: z.array(exerciseManagerSchema) });
export const goalTemplateListResponseSchema = z.object({
  items: z.array(goalTemplateManagerSchema),
});

/** 后台列表（含状态、版本、审定信息） */
export const adminRecipeListResponseSchema = z.object({ items: z.array(recipeSchema) });
export const adminExerciseListResponseSchema = z.object({ items: z.array(exerciseSchema) });
export const adminGoalTemplateListResponseSchema = z.object({ items: z.array(goalTemplateSchema) });

/** 新增：以草稿保存 */
export const createRecipeRequestSchema = recipeContentSchema;
export const createExerciseRequestSchema = exerciseContentSchema;
export const createGoalTemplateRequestSchema = goalTemplateContentSchema;

/** 修改：整条替换内容（code 不能改），版本号加一；必须带上当前版本号，防止覆盖别人的修改 */
export const updateLibraryItemRequestSchema = z.object({
  version: z.number().int().positive(),
  content: z.record(z.string(), z.unknown()),
});
export type UpdateLibraryItemRequest = z.infer<typeof updateLibraryItemRequestSchema>;

/** 状态流转；改为已发布必须填审定人和日期 */
export const libraryStatusRequestSchema = z
  .object({
    version: z.number().int().positive(),
    status: libraryItemStatusSchema,
    reviewedByLabel: z.string().trim().min(1).max(60).optional(),
    reviewedOn: z.iso.date().optional(),
  })
  .refine(
    (v) =>
      v.status !== 'published' || (v.reviewedByLabel !== undefined && v.reviewedOn !== undefined),
    { message: 'publishing needs a reviewer and a date', path: ['reviewedByLabel'] },
  );
export type LibraryStatusRequest = z.infer<typeof libraryStatusRequestSchema>;

/** 保存被拒绝时标出的位置（字段路径 + 命中的词） */
export const libraryContentRejectionSchema = z.object({
  error: z.literal('invalid_content'),
  issues: z.array(z.object({ path: z.string(), term: z.string(), index: z.number().int() })),
});
export type LibraryContentRejection = z.infer<typeof libraryContentRejectionSchema>;

/** 健管师看到的条目详情（GET /api/plan-library/:type/:id）。停用、草稿的条目 404 */
export const recipeDetailResponseSchema = z.object({ item: recipeManagerSchema });
export const exerciseDetailResponseSchema = z.object({ item: exerciseManagerSchema });
export const goalTemplateDetailResponseSchema = z.object({ item: goalTemplateManagerSchema });

/** 后台新增、修改、状态流转后返回的条目 */
export const adminRecipeResponseSchema = z.object({ item: recipeSchema });
export const adminExerciseResponseSchema = z.object({ item: exerciseSchema });
export const adminGoalTemplateResponseSchema = z.object({ item: goalTemplateSchema });

/**
 * 条目的修改记录（只有平台管理员能看）。库条目不是客户数据，可以给出改前改后的原值；
 * 只列内容和状态字段的变化，不列版本号、修改时间这类元数据。
 */
export const libraryItemChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});
export const libraryItemEventSchema = z.object({
  id: z.string(),
  action: z.enum(['created', 'updated', 'status_changed']),
  actorName: z.string().nullable(),
  status: libraryItemStatusSchema,
  version: z.number().int().positive(),
  changes: z.array(libraryItemChangeSchema),
  createdAt: z.iso.datetime(),
});
export type LibraryItemEvent = z.infer<typeof libraryItemEventSchema>;
export const libraryItemEventListResponseSchema = z.object({
  events: z.array(libraryItemEventSchema),
});
export type LibraryItemEventListResponse = z.infer<typeof libraryItemEventListResponseSchema>;

/** 后台列表的筛选（GET /api/admin/plan-library/:type）：平台管理员可按状态筛选 */
export const adminLibraryListQuerySchema = z.object({
  status: libraryItemStatusSchema.optional(),
  q: z.string().trim().max(40).optional(),
});
export type AdminLibraryListQuery = z.infer<typeof adminLibraryListQuerySchema>;
