import { sql, type Kysely } from 'kysely';

/**
 * 过敏原标签加“芝麻”（sesame）：产品负责人 2026-10-27 确认（M5 规格 Q16 的补充）。
 * 0020 的 check 约束按当时的快照写死了七种，这里换成新的八种。已有数据不受影响（只放宽）。
 */
export const ALLERGEN_SNAPSHOT_0021 = [
  'peanut',
  'tree_nut',
  'dairy',
  'egg',
  'seafood',
  'soy',
  'gluten',
  'sesame',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  const list = sql.raw(`array[${ALLERGEN_SNAPSHOT_0021.map((v) => `'${v}'`).join(', ')}]::text[]`);
  await sql`
    alter table plan_library_recipes drop constraint plan_library_recipes_allergens_check;
    alter table plan_library_recipes add constraint plan_library_recipes_allergens_check
      check (allergens <@ ${list});
  `.execute(db);
}
