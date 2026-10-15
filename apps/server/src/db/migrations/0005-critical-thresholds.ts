import { sql, type Kysely } from 'kysely';
import { DEFAULT_CRITICAL_RULES } from '@health-buddy/shared';
import { APP_DB_ROLE } from '../../config.js';

/**
 * 危急指标阈值（M1 规格第五节之二）。
 *
 * - critical_threshold_defaults：平台默认值，只有平台管理员能改；协会管理员能读（恢复默认时用）。
 * - critical_thresholds：每个协会一套。本协会的协会管理员可读写，机构管理员和健管师只读。
 * - 新建协会时自动复制一份默认值；已有协会在本迁移里各复制一份。
 * - 每次增改删都由触发器记录操作人和改前改后的阈值（阈值不是客户数据，可以记数值）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    create table critical_threshold_defaults (
      id uuid primary key default gen_random_uuid(),
      metric text not null check (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
      comparator text not null check (comparator in ('gte', 'gt', 'lte', 'lt')),
      value numeric(12, 3) not null,
      level text not null check (level in ('urgent', 'attention')),
      enabled boolean not null default true,
      updated_by uuid references users (id),
      updated_at timestamptz not null default now(),
      unique (metric, comparator)
    );

    create table critical_thresholds (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      metric text not null check (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
      comparator text not null check (comparator in ('gte', 'gt', 'lte', 'lt')),
      value numeric(12, 3) not null,
      level text not null check (level in ('urgent', 'attention')),
      enabled boolean not null default true,
      updated_by uuid references users (id),
      updated_at timestamptz not null default now(),
      unique (operator_id, metric, comparator)
    );

    create table critical_threshold_events (
      id bigint generated always as identity primary key,
      -- 为空表示修改的是平台默认值
      operator_id uuid references operators (id),
      threshold_id uuid not null,
      actor_id uuid references users (id),
      action text not null check (action in ('created', 'updated', 'deleted')),
      before jsonb,
      after jsonb,
      created_at timestamptz not null default now()
    );
    create index critical_threshold_events_operator_idx
      on critical_threshold_events (operator_id, created_at);

    alter table critical_threshold_defaults enable row level security;
    alter table critical_thresholds enable row level security;
    alter table critical_threshold_events enable row level security;

    create policy critical_threshold_defaults_select on critical_threshold_defaults for select
      using (app_role() in ('platform_admin', 'operator_admin'));
    create policy critical_threshold_defaults_write on critical_threshold_defaults for all
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());

    create policy critical_thresholds_select on critical_thresholds for select using (
      app_role() in ('operator_admin', 'org_admin', 'manager') and operator_id = app_operator_id()
    );
    create policy critical_thresholds_write on critical_thresholds for all
      using (app_role() = 'operator_admin' and operator_id = app_operator_id())
      with check (
        app_role() = 'operator_admin' and operator_id = app_operator_id()
        and updated_by = app_user_id()
      );

    create policy critical_threshold_events_select on critical_threshold_events for select using (
      (app_role() = 'platform_admin' and operator_id is null)
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
    );
  `.execute(db);

  // 修改记录由触发器写入，应用角色不能直接写，也就不能伪造或漏记
  await sql`
    create function critical_threshold_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      rule_fields text[] := array['metric', 'comparator', 'value', 'level', 'enabled'];
      b jsonb;
      a jsonb;
      op_id uuid;
    begin
      if tg_op <> 'INSERT' then
        select jsonb_object_agg(k, v) into b from jsonb_each(to_jsonb(old)) as e(k, v)
          where k = any (rule_fields);
      end if;
      if tg_op <> 'DELETE' then
        select jsonb_object_agg(k, v) into a from jsonb_each(to_jsonb(new)) as e(k, v)
          where k = any (rule_fields);
      end if;
      if tg_table_name = 'critical_thresholds' then
        op_id := coalesce(new.operator_id, old.operator_id);
      end if;
      insert into critical_threshold_events (operator_id, threshold_id, actor_id, action, before, after)
        values (
          op_id,
          coalesce(new.id, old.id),
          app_user_id(),
          case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
          b,
          a
        );
      return coalesce(new, old);
    end
    $$;
    revoke all on function critical_threshold_audit() from public;
    create trigger critical_thresholds_audit after insert or update or delete on critical_thresholds
      for each row execute function critical_threshold_audit();
    create trigger critical_threshold_defaults_audit after insert or update or delete
      on critical_threshold_defaults
      for each row execute function critical_threshold_audit();

    -- 新协会自动复制一份默认值
    create function copy_default_thresholds() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      insert into critical_thresholds (operator_id, metric, comparator, value, level, enabled)
        select new.id, metric, comparator, value, level, enabled from critical_threshold_defaults;
      return new;
    end
    $$;
    revoke all on function copy_default_thresholds() from public;
    create trigger operators_copy_default_thresholds after insert on operators
      for each row execute function copy_default_thresholds();
  `.execute(db);

  for (const r of DEFAULT_CRITICAL_RULES) {
    await sql`
      insert into critical_threshold_defaults (metric, comparator, value, level)
        values (${r.metric}, ${r.comparator}, ${r.value}, ${r.level})
    `.execute(db);
  }
  await sql`
    insert into critical_thresholds (operator_id, metric, comparator, value, level, enabled)
      select o.id, d.metric, d.comparator, d.value, d.level, d.enabled
      from operators o cross join critical_threshold_defaults d
  `.execute(db);

  await sql`
    grant select, insert, update, delete on critical_threshold_defaults, critical_thresholds to ${app};
    grant select on critical_threshold_events to ${app};
  `.execute(db);
}
