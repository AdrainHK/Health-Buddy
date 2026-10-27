import { loadPlanLibrarySeed, type PlanLibrarySeed } from '@health-buddy/plan-library';
import { sql, type Kysely } from 'kysely';

export interface PlanLibrarySeedResult {
  recipes: number;
  exercises: number;
  goalTemplates: number;
}

/**
 * 把方案库的种子内容导入数据库（M5 规格 4.1）。部署时迁移之后执行，以数据库所有者身份写入
 * （系统操作，触发器放行非草稿状态），可以反复执行：
 * - 只插入数据库里还没有的 code，已有的条目（平台管理员改过、停用过的）一律不动，内容以数据库为准；
 * - 新导入的条目状态为“待审定”（review），只在预览环境（PLAN_LIBRARY_PREVIEW=true）可用，
 *   发布前由营养、运动顾问在总后台审定。
 */
export async function importPlanLibrarySeed(
  db: Kysely<unknown>,
  seed: PlanLibrarySeed = loadPlanLibrarySeed(),
): Promise<PlanLibrarySeedResult> {
  const result: PlanLibrarySeedResult = { recipes: 0, exercises: 0, goalTemplates: 0 };
  await db.transaction().execute(async (trx) => {
    for (const r of seed.recipes) {
      const { rows } = await sql`
        insert into plan_library_recipes (code, name, meal_types, ingredients, steps,
          nutrition_per_serving, nutrition_basis, tags, allergens, source_note, status)
        values (${r.code}, ${r.name}, ${r.mealTypes}, ${JSON.stringify(r.ingredients)}::jsonb,
          ${JSON.stringify(r.steps)}::jsonb,
          ${r.nutritionPerServing ? JSON.stringify(r.nutritionPerServing) : null}::jsonb,
          ${r.nutritionBasis}, ${r.tags}, ${r.allergens}, ${r.sourceNote}, 'review')
        on conflict (code) do nothing
        returning id
      `.execute(trx);
      result.recipes += rows.length;
    }
    for (const e of seed.exercises) {
      const { rows } = await sql`
        insert into plan_library_exercises (code, name, category, intensity, setting, equipment,
          steps, key_points, common_mistakes, manager_cautions, met, source_note, status)
        values (${e.code}, ${e.name}, ${e.category}, ${e.intensity}, ${e.setting}, ${e.equipment},
          ${JSON.stringify(e.steps)}::jsonb, ${JSON.stringify(e.keyPoints)}::jsonb,
          ${JSON.stringify(e.commonMistakes)}::jsonb, ${e.managerCautions}, ${e.met},
          ${e.sourceNote}, 'review')
        on conflict (code) do nothing
        returning id
      `.execute(trx);
      result.exercises += rows.length;
    }
    for (const g of seed.goalTemplates) {
      const { rows } = await sql`
        insert into plan_goal_templates (code, section, text, params, metric, metric_param,
          source_note, status)
        values (${g.code}, ${g.section}, ${g.text}, ${JSON.stringify(g.params)}::jsonb, ${g.metric},
          ${g.metricParam}, ${g.sourceNote}, 'review')
        on conflict (code) do nothing
        returning id
      `.execute(trx);
      result.goalTemplates += rows.length;
    }
  });
  return result;
}
