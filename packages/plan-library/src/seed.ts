import { readFileSync } from 'node:fs';
import {
  exerciseContentSchema,
  goalTemplateContentSchema,
  recipeContentSchema,
  type ExerciseContent,
  type GoalTemplateContent,
  type RecipeContent,
} from '@health-buddy/shared';
import { z } from 'zod';

/**
 * 方案库的种子内容（M5 规格 4.1）：平台编写的初稿，导入数据库时状态为“待审定”，
 * 只有预览环境（PLAN_LIBRARY_PREVIEW=true）可用，发布前由营养、运动顾问审定。
 * 以后平台管理员在后台修改的内容以数据库为准，种子只用于新环境初始化（已有的 code 不覆盖）。
 *
 * 文件在包根目录的 seed/ 下，源码（测试）和 dist（运行时）都从 ../seed 读取。
 */
export interface PlanLibrarySeed {
  recipes: RecipeContent[];
  exercises: ExerciseContent[];
  goalTemplates: GoalTemplateContent[];
}

function readSeed<T extends z.ZodType>(file: string, item: T): z.infer<T>[] {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../seed/${file}`, import.meta.url), 'utf8'),
  );
  return z.array(item).parse(raw);
}

let cached: PlanLibrarySeed | undefined;

/** 读取并校验种子文件；格式不对直接抛错（构建时的测试会先发现） */
export function loadPlanLibrarySeed(): PlanLibrarySeed {
  cached ??= {
    recipes: readSeed('recipes.json', recipeContentSchema),
    exercises: readSeed('exercises.json', exerciseContentSchema),
    goalTemplates: readSeed('goal-templates.json', goalTemplateContentSchema),
  };
  return cached;
}
