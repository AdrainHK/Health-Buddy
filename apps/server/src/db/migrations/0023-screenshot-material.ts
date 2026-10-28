import { sql, type Kysely } from 'kysely';

/**
 * 随访素材加来源“聊天截图”（screenshot）：产品负责人 2026-10-28 决定（M5 规格 Q21 改为 B）。
 * 存的是健管师核对过的转写文字，原图不保存；只放宽 0020 的 check 约束，已有数据不受影响。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table visit_materials drop constraint visit_materials_kind_check;
    alter table visit_materials add constraint visit_materials_kind_check
      check (kind in ('paste', 'txt', 'screenshot'));
  `.execute(db);
}
