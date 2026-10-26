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
 *
 * 自动生成的标题带客户称呼。客户转出或删除时 detach_client_work 把自动标题改回默认，
 * 读列表时再按没有客户的方式补标题，原健管师的只读任务里不再留着这位客户的称呼（租户隔离复审）。
 * 健管师自己起的标题（manual）不动。其余逻辑与 0010 相同。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tasks
      add column title_source text not null default 'manual' check (
        title_source in ('default', 'auto_text', 'auto_skill', 'manual')
      );
    update tasks set title_source = 'default' where title = '新任务';

    create or replace function detach_client_work(p_client_id uuid, p_reason text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      perform 1 from tasks t where t.client_id = p_client_id order by t.id for update;

      with voided as (
        update artifacts set status = 'voided'
          where status = 'draft'
            and (client_id = p_client_id
                 or task_id in (select t.id from tasks t where t.client_id = p_client_id))
          returning id, operator_id, org_id, manager_id
      )
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        select id, operator_id, org_id, manager_id, null, 'voided' from voided;

      update client_risk_tiers set source_artifact_id = null
        where client_id = p_client_id and source_artifact_id is not null;

      -- 原健管师的产物不再指向这位客户的报告（报告跟着客户走）
      update artifacts set source_report_id = null
        where source_report_id is not null
          and (client_id = p_client_id
               or task_id in (select t.id from tasks t where t.client_id = p_client_id));

      update task_messages set client_refs = '{}', report_refs = '{}'
        where task_id in (select t.id from tasks t where t.client_id = p_client_id);

      update tasks set
          client_id = null,
          detached_reason = p_reason,
          archived_at = coalesce(archived_at, now()),
          updated_at = now(),
          -- 自动标题带客户称呼，改回默认（读列表时重新生成不带称呼的标题）
          title = case when title_source in ('auto_text', 'auto_skill') then '新任务' else title end,
          title_source = case when title_source in ('auto_text', 'auto_skill') then 'default' else title_source end
        where client_id = p_client_id;
    end
    $$;
    revoke all on function detach_client_work(uuid, text) from public;
  `.execute(db);
}
