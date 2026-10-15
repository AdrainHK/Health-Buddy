import { sql, type Kysely } from 'kysely';

/**
 * 危急指标阈值改为平台统一设置（Q12 的最终决定，2026年10月15日）。
 *
 * - 去掉协会这一层：删除每个协会的阈值表和“新建协会时复制默认值”的触发器。
 * - 原来的平台默认值表改名为 critical_thresholds，作为全平台唯一的一套阈值。
 * - 只有平台管理员能改；协会管理员、机构管理员和健管师只读（健管师读它来识别危急指标）。
 * - 修改记录只有平台管理员能看，不再按协会区分。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger operators_copy_default_thresholds on operators;
    drop function copy_default_thresholds();
    drop table critical_thresholds;

    drop policy critical_threshold_events_select on critical_threshold_events;
    delete from critical_threshold_events where operator_id is not null;
    drop index critical_threshold_events_operator_idx;
    alter table critical_threshold_events drop column operator_id;
    create index critical_threshold_events_created_idx on critical_threshold_events (created_at);
    create policy critical_threshold_events_select on critical_threshold_events for select
      using (app_role() = 'platform_admin');

    drop policy critical_threshold_defaults_select on critical_threshold_defaults;
    drop policy critical_threshold_defaults_write on critical_threshold_defaults;
    alter table critical_threshold_defaults rename to critical_thresholds;
    alter table critical_thresholds
      rename constraint critical_threshold_defaults_pkey to critical_thresholds_pkey;
    alter table critical_thresholds
      rename constraint critical_threshold_defaults_metric_comparator_key
      to critical_thresholds_metric_comparator_key;
    alter trigger critical_threshold_defaults_audit on critical_thresholds
      rename to critical_thresholds_audit;

    create policy critical_thresholds_select on critical_thresholds for select using (
      app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager')
    );
    create policy critical_thresholds_write on critical_thresholds for all
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());

    create or replace function critical_threshold_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      rule_fields text[] := array['metric', 'comparator', 'value', 'level', 'enabled'];
      b jsonb;
      a jsonb;
    begin
      if tg_op <> 'INSERT' then
        select jsonb_object_agg(k, v) into b from jsonb_each(to_jsonb(old)) as e(k, v)
          where k = any (rule_fields);
      end if;
      if tg_op <> 'DELETE' then
        select jsonb_object_agg(k, v) into a from jsonb_each(to_jsonb(new)) as e(k, v)
          where k = any (rule_fields);
      end if;
      insert into critical_threshold_events (threshold_id, actor_id, action, before, after)
        values (
          coalesce(new.id, old.id),
          app_user_id(),
          case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
          b,
          a
        );
      return coalesce(new, old);
    end
    $$;
  `.execute(db);
}
