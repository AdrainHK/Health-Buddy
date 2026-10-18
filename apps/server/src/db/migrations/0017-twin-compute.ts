import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M4 第 2 步：孪生计算队列、统计和健管师时区（规格 3.2、7.1、7.2 统计视图、Q13）。
 *
 * - monitoring_readings 补 created_at（写入时间，由触发器填写）：判断“数据进来之前的那份预测”（6.4）
 *   和手动调整“到下次有新数据时失效”（Q4）都要知道读数是什么时候进来的。
 * - twin_compute_state：每位客户的计算状态（请求时间、完成时间），用来显示“正在更新”、
 *   判断客户是否已经算过。和其他孪生表一样带租户列、跟着客户走，只有健管师本人能读写。
 * - 队列任务只带 client_id。执行时由 twin_compute_context 从数据库找出客户当前的健管师，
 *   以他的租户上下文读写；这个函数和批量重算用的两个函数只能在没有租户上下文的连接上调用
 *   （后台任务），只返回身份或客户 id，不返回任何健康数据。
 * - 孪生统计 twin_usage_stats（同 M3 expert_usage_stats）：SECURITY DEFINER，只返回按协会、日期汇总的
 *   数字，不含 manager_id、client_id；运营商只看本协会，平台看全部，其他角色拒绝。
 * - 状态历史的触发原因增加 backfill：M4 上线前已有数据的客户第一次打开孪生时补算，按批量处理。
 * - users.timezone：健管师的时区，跟进清单的“今日”按它算（Q13）；只能经 user_set_timezone 改自己的。
 */

/** 客户相关的表，客户换机构时同步租户列（沿用 0016 的列表，加上本迁移的表） */
const CLIENT_RECORD_TABLES = [
  'health_reports',
  'report_indicators',
  'client_health_history',
  'client_risk_tiers',
  'report_uploads',
  'report_files',
  'extracted_values',
  'report_events',
  'monitoring_readings',
  'twin_status_history',
  'twin_forecasts',
  'follow_up_items',
  'follow_up_events',
  'twin_compute_state',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  // ---------- 1. 监测读数的写入时间 ----------
  await sql`
    alter table monitoring_readings add column created_at timestamptz not null default now();
    create index monitoring_readings_created_idx on monitoring_readings (client_id, created_at);

    -- 沿用 0016 的校验，另外由触发器填写写入时间，应用不能伪造
    create or replace function monitoring_readings_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return coalesce(new, old);
      end if;
      if tg_op = 'INSERT' then
        if new.source <> 'manual' or new.created_by is distinct from app_user_id() then
          raise exception 'reading must be entered manually by the current user'
            using errcode = 'check_violation';
        end if;
        if new.measured_at > now() + interval '5 minutes' then
          raise exception 'reading cannot be in the future' using errcode = 'check_violation';
        end if;
        new.created_at := now();
        return new;
      end if;
      if old.source <> 'manual' or old.created_by is distinct from app_user_id() then
        raise exception 'only own manual readings can be deleted' using errcode = 'check_violation';
      end if;
      return old;
    end
    $$;
  `.execute(db);

  // ---------- 2. 状态历史的触发原因增加 backfill ----------
  await sql`
    alter table twin_status_history drop constraint twin_status_history_trigger_check;
    alter table twin_status_history add constraint twin_status_history_trigger_check
      check (trigger in ('report_verified', 'correction', 'monitoring', 'rules_changed',
        'thresholds_changed', 'manual', 'seed', 'backfill'));
  `.execute(db);

  // ---------- 3. 计算状态 ----------
  await sql`
    create table twin_compute_state (
      client_id uuid primary key,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      -- 最近一次请求重算的时间（数据写入、规则修改时）
      requested_at timestamptz,
      -- 最近一次算完的时间
      computed_at timestamptz,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index twin_compute_state_manager_idx on twin_compute_state (manager_id);
    alter table twin_compute_state enable row level security;
    create trigger twin_compute_state_tenant before insert or update on twin_compute_state
      for each row execute function client_record_tenant();
    create policy twin_compute_state_manager on twin_compute_state for all
      using (app_role() = 'manager' and manager_id = app_user_id())
      with check (
        app_role() = 'manager' and manager_id = app_user_id()
        and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
      );
    grant select, insert on twin_compute_state to ${app};
    grant update (requested_at, computed_at) on twin_compute_state to ${app};
  `.execute(db);

  // ---------- 4. 队列任务用的函数（只能由后台任务调用） ----------
  await sql`
    -- 队列任务只带 client_id：按客户找到当前的健管师，再以他的身份建立租户上下文（规格 3.2）。
    -- 只对在职健管师、正常的协会返回；只返回身份，不返回任何业务数据。
    create function twin_compute_context(p_client_id uuid)
      returns table (user_id uuid, role user_role, operator_id uuid, org_id uuid)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'twin compute is a system task' using errcode = 'insufficient_privilege';
      end if;
      return query
        select u.id, u.role, u.operator_id, u.org_id
        from clients c
        join users u on u.id = c.manager_id
        left join operators o on o.id = u.operator_id
        where c.id = p_client_id and u.role = 'manager'
          and u.status = 'active' and coalesce(o.status = 'active', true);
    end
    $$;

    -- 规则或危急阈值修改后的批量重算（Q22）：把所有客户标为“正在更新”，返回客户 id。
    create function twin_request_all() returns setof uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'twin compute is a system task' using errcode = 'insufficient_privilege';
      end if;
      -- 只算健管师在职、协会正常的客户（和 twin_compute_context 的条件一致）；
      -- 否则任务会被拒绝，客户会一直显示“正在更新”
      insert into twin_compute_state (client_id, operator_id, org_id, manager_id, requested_at)
        select c.id, c.operator_id, c.org_id, c.manager_id, now()
        from clients c
        join users u on u.id = c.manager_id
        left join operators o on o.id = u.operator_id
        where u.role = 'manager' and u.status = 'active' and coalesce(o.status = 'active', true)
        on conflict (client_id) do update set requested_at = excluded.requested_at;
      return query
        select c.id from clients c
        join users u on u.id = c.manager_id
        left join operators o on o.id = u.operator_id
        where u.role = 'manager' and u.status = 'active' and coalesce(o.status = 'active', true)
        order by c.id;
    end
    $$;

    -- 还没有算过的客户（合成数据生成后的全量计算）。synthetic_only 时只返回合成客户。
    create function twin_pending_clients(p_synthetic_only boolean) returns setof uuid
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'twin compute is a system task' using errcode = 'insufficient_privilege';
      end if;
      return query
        select c.id from clients c
        where not exists (select 1 from twin_compute_state s where s.client_id = c.id)
          and (not p_synthetic_only or c.is_synthetic)
        order by c.id;
    end
    $$;

    revoke all on function twin_compute_context(uuid) from public;
    revoke all on function twin_request_all() from public;
    revoke all on function twin_pending_clients(boolean) from public;
    grant execute on function twin_compute_context(uuid), twin_request_all(),
      twin_pending_clients(boolean) to ${app};
  `.execute(db);

  // ---------- 5. 统计 ----------
  await sql`
    -- 孪生打开次数（按协会、UTC 日期）。不记谁打开了哪位客户；应用角色没有任何权限，只能经函数加一
    create table twin_usage_daily (
      operator_id uuid not null references operators (id) on delete cascade,
      day date not null,
      opens int not null default 0 check (opens >= 0),
      primary key (operator_id, day)
    );
    alter table twin_usage_daily enable row level security;

    create function twin_record_open() returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'manager' and app_role() is distinct from 'org_admin'
        or app_operator_id() is null
      then
        raise exception 'twin open must be recorded by a manager or org admin'
          using errcode = 'insufficient_privilege';
      end if;
      insert into twin_usage_daily (operator_id, day, opens)
        values (app_operator_id(), (now() at time zone 'UTC')::date, 1)
        on conflict (operator_id, day) do update set opens = twin_usage_daily.opens + 1;
    end
    $$;
    revoke all on function twin_record_open() from public;

    create function twin_usage_stats(p_from date, p_to date, p_operator_id uuid default null)
      returns table (
        operator_id uuid,
        day text,
        opens int,
        follow_ups_created int,
        done int,
        snoozed int,
        dismissed int,
        reopened int,
        summaries int
      )
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    #variable_conflict use_column
    declare
      v_operator uuid;
      v_start timestamptz;
      v_end timestamptz;
    begin
      if app_role() = 'platform_admin' then
        v_operator := p_operator_id;
      elsif app_role() = 'operator_admin' and app_operator_id() is not null then
        -- 运营商请求别的协会也只返回本协会
        v_operator := app_operator_id();
      else
        raise exception 'twin usage stats not allowed' using errcode = 'insufficient_privilege';
      end if;
      if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
        raise exception 'invalid date range' using errcode = 'invalid_parameter_value';
      end if;
      v_start := p_from::timestamp at time zone 'UTC';
      v_end := (p_to + 1)::timestamp at time zone 'UTC';

      return query
        with x as (
          select u.operator_id, to_char(u.day, 'YYYY-MM-DD') as d, u.opens as o,
                 0 as c, 0 as dn, 0 as sn, 0 as di, 0 as re, 0 as su
          from twin_usage_daily u
          where u.day between p_from and p_to and (v_operator is null or u.operator_id = v_operator)
          union all
          select e.operator_id, to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD'), 0,
                 (e.action = 'created')::int, (e.action = 'done')::int, (e.action = 'snoozed')::int,
                 (e.action = 'dismissed')::int, (e.action = 'reopened')::int, 0
          from follow_up_events e
          where e.created_at >= v_start and e.created_at < v_end
            and e.action in ('created', 'done', 'snoozed', 'dismissed', 'reopened')
            and (v_operator is null or e.operator_id = v_operator)
          union all
          select a.operator_id, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD'),
                 0, 0, 0, 0, 0, 0, 1
          from artifacts a
          where a.kind = 'twin_summary' and a.version = 1
            and a.created_at >= v_start and a.created_at < v_end
            and (v_operator is null or a.operator_id = v_operator)
        )
        select x.operator_id, x.d, sum(x.o)::int, sum(x.c)::int, sum(x.dn)::int, sum(x.sn)::int,
               sum(x.di)::int, sum(x.re)::int, sum(x.su)::int
        from x
        group by x.operator_id, x.d
        order by x.d, x.operator_id;
    end
    $$;
    revoke all on function twin_usage_stats(date, date, uuid) from public;
    grant execute on function twin_record_open(), twin_usage_stats(date, date, uuid) to ${app};
  `.execute(db);

  // ---------- 6. 健管师时区（Q13） ----------
  await sql`
    alter table users add column timezone text check (char_length(timezone) between 1 and 64);
    grant select (timezone) on users to ${app};

    -- 只能改自己的时区；时区名必须在数据库的时区表里
    create function user_set_timezone(p_tz text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_user_id() is null then
        raise exception 'no current user' using errcode = 'insufficient_privilege';
      end if;
      if p_tz is not null and not exists (select 1 from pg_timezone_names where name = p_tz) then
        raise exception 'unknown time zone' using errcode = 'invalid_parameter_value';
      end if;
      update users set timezone = p_tz where id = app_user_id();
    end
    $$;
    revoke all on function user_set_timezone(text) from public;
    grant execute on function user_set_timezone(text) to ${app};
  `.execute(db);

  // 客户换机构时 twin_compute_state 的租户列也跟着同步
  const tables = CLIENT_RECORD_TABLES.map((t) => `'${t}'`).join(', ');
  await sql`
    create or replace function clients_sync_record_tenant() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      t text;
    begin
      foreach t in array array[${sql.raw(tables)}]
      loop
        execute format(
          'update %I set operator_id = $1, org_id = $2 where client_id = $3 '
          'and (operator_id is distinct from $1 or org_id is distinct from $2)', t)
          using new.operator_id, new.org_id, new.id;
      end loop;
      return new;
    end
    $$;
    revoke all on function clients_sync_record_tenant() from public;
  `.execute(db);
}
