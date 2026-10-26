import { sql, type Kysely } from 'kysely';

/**
 * 任务标题自动生成（产品负责人反馈：对话记录列表每一行都是“新任务”）。
 *
 * tasks.title_source 记录标题的来历：
 * - default：还是默认的“新任务”，第一次发消息时按这一轮的内容生成；
 * - auto_text：按问一问、想一想的问题摘要生成，之后第一次调用技能时换成技能标题；
 * - auto_skill：按技能生成，之后不再自动改；
 * - manual：健管师新建时给了标题或改过名，不再自动改。
 *
 * 已有数据：标题是“新任务”的记为 default，后端在读任务列表时按第一条消息补上标题（不在迁移里
 * 复制标题规则）；其他标题记为 manual。授权不变（tasks 是整表授权），触发器只保护身份列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tasks
      add column title_source text not null default 'manual' check (
        title_source in ('default', 'auto_text', 'auto_skill', 'manual')
      );
    update tasks set title_source = 'default' where title = '新任务';
  `.execute(db);
}
