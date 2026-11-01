import { sql, type Kysely } from 'kysely';

/**
 * M8 第 5 步：科普导出 Word 和 PPTX（规格 2.1 第 7 条，Q5）。导出记录的格式加上 docx、pptx。
 * 只放宽约束，不动数据。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table artifact_events drop constraint artifact_events_format_check;
    alter table artifact_events add constraint artifact_events_format_check
      check (format in ('png', 'pdf', 'docx', 'pptx'));
  `.execute(db);
}
