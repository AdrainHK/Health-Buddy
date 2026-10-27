import {
  adminExerciseListResponseSchema,
  adminExerciseResponseSchema,
  adminGoalTemplateListResponseSchema,
  adminGoalTemplateResponseSchema,
  adminRecipeListResponseSchema,
  adminRecipeResponseSchema,
  libraryItemEventListResponseSchema,
  type Exercise,
  type ExerciseContent,
  type GoalTemplate,
  type GoalTemplateContent,
  type LibraryItemEvent,
  type LibraryItemType,
  type LibraryStatusRequest,
  type Recipe,
  type RecipeContent,
} from '@health-buddy/shared';
import type { z } from 'zod';
import { apiRequest } from './http';

/**
 * 方案库后台接口（M5 规格 2.12、6.4）。读：三级管理员（协会、机构只看到已发布的）；
 * 写：只有平台管理员，其他角色后端返回 403。内容不合格时后端返回 400 invalid_content 并标出位置。
 */
export interface LibraryItemByType {
  recipe: Recipe;
  exercise: Exercise;
  goal_template: GoalTemplate;
}
export interface LibraryContentByType {
  recipe: RecipeContent;
  exercise: ExerciseContent;
  goal_template: GoalTemplateContent;
}

const PATHS: Record<LibraryItemType, string> = {
  recipe: 'recipes',
  exercise: 'exercises',
  goal_template: 'goal-templates',
};

const LIST_SCHEMAS = {
  recipe: adminRecipeListResponseSchema,
  exercise: adminExerciseListResponseSchema,
  goal_template: adminGoalTemplateListResponseSchema,
} as const;

const ITEM_SCHEMAS = {
  recipe: adminRecipeResponseSchema,
  exercise: adminExerciseResponseSchema,
  goal_template: adminGoalTemplateResponseSchema,
} as const;

function itemSchema<T extends LibraryItemType>(type: T) {
  return ITEM_SCHEMAS[type] as unknown as z.ZodType<{ item: LibraryItemByType[T] }>;
}

export async function listLibrary<T extends LibraryItemType>(
  type: T,
): Promise<LibraryItemByType[T][]> {
  const schema = LIST_SCHEMAS[type] as unknown as z.ZodType<{ items: LibraryItemByType[T][] }>;
  const { items } = await apiRequest(`/admin/plan-library/${PATHS[type]}`, schema);
  return items;
}

export async function createLibraryItem<T extends LibraryItemType>(
  type: T,
  content: LibraryContentByType[T],
): Promise<LibraryItemByType[T]> {
  const { item } = await apiRequest(`/admin/plan-library/${PATHS[type]}`, itemSchema(type), {
    method: 'POST',
    body: content,
  });
  return item;
}

export async function updateLibraryItem<T extends LibraryItemType>(
  type: T,
  id: string,
  version: number,
  content: LibraryContentByType[T],
): Promise<LibraryItemByType[T]> {
  const { item } = await apiRequest(
    `/admin/plan-library/${PATHS[type]}/${encodeURIComponent(id)}`,
    itemSchema(type),
    { method: 'PATCH', body: { version, content } },
  );
  return item;
}

export async function setLibraryStatus<T extends LibraryItemType>(
  type: T,
  id: string,
  body: LibraryStatusRequest,
): Promise<LibraryItemByType[T]> {
  const { item } = await apiRequest(
    `/admin/plan-library/${PATHS[type]}/${encodeURIComponent(id)}/status`,
    itemSchema(type),
    { method: 'POST', body },
  );
  return item;
}

export async function listLibraryEvents(
  type: LibraryItemType,
  id: string,
): Promise<LibraryItemEvent[]> {
  const { events } = await apiRequest(
    `/admin/plan-library/${PATHS[type]}/${encodeURIComponent(id)}/events`,
    libraryItemEventListResponseSchema,
  );
  return events;
}
