import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M7 第 4 步：套餐和额度（规格 2.5、6.1，Q6）。
 *
 * - plans：平台定义的套餐，功能开关（experts、twin、care、companion）和每月额度
 *   （llm_calls、expert_calls、report_pages；companion_devices 是同时绑定的设备数上限）。
 *   额度为 null 表示不另设上限，只受 M1–M6 的技术性上限。Q6 没定之前内置一档“试点版”（pilot）：
 *   全部功能开、额度全 null；拿到 Q6 后只改平台数据。
 * - operator_plans：协会可售哪些套餐（平台设）；user_plans：健管师的套餐（协会在可售范围内分配）。
 *   没有分配的健管师按试点版处理。
 * - quota_usage_daily：健管师本人每天各项用量（北京时间的日期），只经 quota_consume 写。
 *   月额度按北京时间的自然月合计；超额时不记数、返回 false，调用方返回 429 quota_exceeded。
 * 写操作都是 SECURITY DEFINER 函数，开头校验调用者角色、写审计。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    create table plans (
      id uuid primary key default gen_random_uuid(),
      code text not null check (code ~ '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
      name text not null check (char_length(name) between 1 and 20),
      features jsonb not null,
      monthly_quotas jsonb not null,
      status text not null default 'active' check (status in ('active', 'retired')),
      updated_by uuid references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index plans_code_key on plans (lower(code));
    alter table plans enable row level security;
    -- 套餐定义不是租户数据，登录的四级账号都能读；伴侣设备角色读不到（M6 验收 20）
    create policy plans_select on plans for select using (
      app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager')
    );
    grant select on plans to ${app};

    insert into plans (code, name, features, monthly_quotas) values ('pilot', '试点版',
      '{"experts": true, "twin": true, "care": true, "companion": true}',
      '{"llm_calls": null, "expert_calls": null, "report_pages": null, "companion_devices": null}');

    create table operator_plans (
      operator_id uuid not null references operators (id),
      plan_id uuid not null references plans (id),
      primary key (operator_id, plan_id)
    );
    alter table operator_plans enable row level security;
    create policy operator_plans_select on operator_plans for select using (
      app_role() = 'platform_admin' or operator_id = app_operator_id()
    );
    grant select on operator_plans to ${app};
    -- 现有协会都可售试点版
    insert into operator_plans (operator_id, plan_id)
      select o.id, p.id from operators o cross join plans p where p.code = 'pilot';

    create table user_plans (
      user_id uuid primary key references users (id) on delete cascade,
      plan_id uuid not null references plans (id),
      assigned_by uuid references users (id),
      assigned_at timestamptz not null default now()
    );
    alter table user_plans enable row level security;
    create policy user_plans_select on user_plans for select using (
      app_role() = 'platform_admin'
      or user_id = app_user_id()
      or exists (select 1 from users u where u.id = user_plans.user_id and (
        (app_role() = 'operator_admin' and u.operator_id = app_operator_id())
        or (app_role() = 'org_admin' and u.org_id = app_org_id())
      ))
    );
    grant select on user_plans to ${app};

    create table quota_usage_daily (
      user_id uuid not null references users (id) on delete cascade,
      operator_id uuid references operators (id),
      org_id uuid,
      day date not null,
      metric text not null check (metric in ('llm_calls', 'expert_calls', 'report_pages')),
      count int not null check (count >= 0),
      primary key (user_id, day, metric)
    );
    create index quota_usage_daily_operator_idx on quota_usage_daily (operator_id, day);
    alter table quota_usage_daily enable row level security;
    create policy quota_usage_daily_select on quota_usage_daily for select using (
      app_role() = 'platform_admin'
      or user_id = app_user_id()
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
      or (app_role() = 'org_admin' and org_id = app_org_id())
    );
    grant select on quota_usage_daily to ${app};

    alter table admin_audit_log drop constraint admin_audit_log_object_type_check;
    alter table admin_audit_log add constraint admin_audit_log_object_type_check
      check (object_type in ('operator', 'organization', 'user', 'plan'));
    alter table admin_audit_log drop constraint admin_audit_log_action_check;
    alter table admin_audit_log add constraint admin_audit_log_action_check
      check (action in ('created', 'updated', 'suspended', 'resumed', 'invited', 'reinvited',
        'activated', 'disabled', 'enabled', 'retired', 'plan_assigned'));
  `.execute(db);

  await sql`
    -- 功能开关、额度的形状：键固定，额度是非负整数或 null
    create function plan_shape_ok(p_features jsonb, p_quotas jsonb) returns boolean
      language sql immutable set search_path = pg_catalog, public, pg_temp
    as $$
      select jsonb_typeof(p_features) = 'object' and jsonb_typeof(p_quotas) = 'object'
        and (select array_agg(k order by k) from jsonb_object_keys(p_features) k)
          = array['care', 'companion', 'experts', 'twin']
        and (select bool_and(jsonb_typeof(v) = 'boolean') from jsonb_each(p_features) e(k, v))
        and (select array_agg(k order by k) from jsonb_object_keys(p_quotas) k)
          = array['companion_devices', 'expert_calls', 'llm_calls', 'report_pages']
        and (select bool_and(jsonb_typeof(v) = 'null'
            or (jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and 10000000
              and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)))
          from jsonb_each(p_quotas) e(k, v))
    $$;
    alter table plans add constraint plans_shape check (plan_shape_ok(features, monthly_quotas));

    create function admin_plan_snapshot(p plans) returns jsonb
      language sql immutable set search_path = pg_catalog, public, pg_temp
    as $$
      select jsonb_build_object('code', p.code, 'name', p.name, 'features', p.features,
        'monthly_quotas', p.monthly_quotas, 'status', p.status)
    $$;

    -- 新建（p_id 为 null）或修改套餐。只有平台；修改影响所有用这个套餐的账号（前端二次确认）
    create function admin_save_plan(p_id uuid, p_code text, p_name text, p_features jsonb,
      p_quotas jsonb) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare b plans; a plans;
    begin
      perform admin_require_platform();
      if p_id is null then
        insert into plans (code, name, features, monthly_quotas, updated_by)
          values (lower(trim(p_code)), trim(p_name), p_features, p_quotas, app_user_id())
          returning * into a;
        perform admin_audit(null, 'plan', a.id, 'created', null, admin_plan_snapshot(a));
        return a.id;
      end if;
      select * into b from plans where id = p_id for update;
      if not found then return null; end if;
      -- 代码不变（协会的导入文件里用的是代码）
      update plans set name = trim(p_name), features = p_features, monthly_quotas = p_quotas,
          updated_by = app_user_id(), updated_at = now()
        where id = p_id returning * into a;
      perform admin_audit(null, 'plan', p_id, 'updated', admin_plan_snapshot(b),
        admin_plan_snapshot(a));
      return p_id;
    end
    $$;

    -- 停售：不能再分配给新账号、也不再可售；已经在用的账号保留（规格 2.5 第 2 条，不自动换）
    create function admin_retire_plan(p_id uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare b plans; a plans;
    begin
      perform admin_require_platform();
      select * into b from plans where id = p_id for update;
      if not found then return false; end if;
      if b.code = 'pilot' then
        raise exception 'pilot plan cannot be retired' using errcode = 'check_violation';
      end if;
      if b.status = 'retired' then return true; end if;
      update plans set status = 'retired', updated_by = app_user_id(), updated_at = now()
        where id = p_id returning * into a;
      perform admin_audit(null, 'plan', p_id, 'retired', admin_plan_snapshot(b),
        admin_plan_snapshot(a));
      return true;
    end
    $$;

    -- 协会可售哪些套餐（平台设）。只能选在售的；已分配给账号的套餐即使不再可售也保留
    create function admin_set_operator_plans(p_operator uuid, p_plans uuid[]) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_before jsonb; v_after jsonb;
    begin
      perform admin_require_platform();
      if not exists (select 1 from operators where id = p_operator) then return false; end if;
      if exists (select 1 from unnest(coalesce(p_plans, '{}')) x(id)
        where not exists (select 1 from plans p where p.id = x.id and p.status = 'active'))
      then
        raise exception 'plan not available' using errcode = 'HB003';
      end if;
      select coalesce(jsonb_agg(p.code order by p.code), '[]') into v_before
        from operator_plans op join plans p on p.id = op.plan_id where op.operator_id = p_operator;
      delete from operator_plans where operator_id = p_operator
        and plan_id <> all (coalesce(p_plans, '{}'));
      insert into operator_plans (operator_id, plan_id)
        select p_operator, x.id from unnest(coalesce(p_plans, '{}')) x(id)
        on conflict do nothing;
      select coalesce(jsonb_agg(p.code order by p.code), '[]') into v_after
        from operator_plans op join plans p on p.id = op.plan_id where op.operator_id = p_operator;
      if v_before is distinct from v_after then
        perform admin_audit(p_operator, 'operator', p_operator, 'updated',
          jsonb_build_object('plans', v_before), jsonb_build_object('plans', v_after));
      end if;
      return true;
    end
    $$;

    -- 套餐在这个协会能不能分配：在售且可售
    create function plan_sellable(p_operator uuid, p_plan uuid) returns boolean
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select exists (select 1 from operator_plans op join plans p on p.id = op.plan_id
        where op.operator_id = p_operator and op.plan_id = p_plan and p.status = 'active')
    $$;

    -- 运营商管理员给本协会的健管师分配套餐
    create function admin_assign_plan(p_user uuid, p_plan uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_op uuid; u users; v_before text; v_after text;
    begin
      v_op := admin_require_operator();
      select * into u from users where id = p_user and operator_id = v_op and role = 'manager'
        for update;
      if not found then return false; end if;
      -- 和停售并发时不分配出刚停售的套餐（租户审查 N4）
      perform 1 from plans where id = p_plan for share;
      if not plan_sellable(v_op, p_plan) then
        raise exception 'plan not available' using errcode = 'HB003';
      end if;
      select p.code into v_before from user_plans up join plans p on p.id = up.plan_id
        where up.user_id = p_user;
      insert into user_plans (user_id, plan_id, assigned_by) values (p_user, p_plan, app_user_id())
        on conflict (user_id) do update set plan_id = excluded.plan_id,
          assigned_by = excluded.assigned_by, assigned_at = now();
      select code into v_after from plans where id = p_plan;
      if v_before is distinct from v_after then
        perform admin_audit(v_op, 'user', p_user, 'plan_assigned',
          jsonb_build_object('plan', v_before), jsonb_build_object('plan', v_after));
      end if;
      return true;
    end
    $$;

    -- 健管师当前的套餐：分配了的用分配的，没分配的用试点版
    create function effective_plan(p_user uuid) returns plans
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select p.* from plans p
      where p.id = coalesce((select plan_id from user_plans where user_id = p_user),
        (select id from plans where code = 'pilot'))
    $$;

    /*
     * 记一次用量（健管师本人，从会话取）：本月已用 + n 超过套餐额度时返回 false、不记数；
     * p_bypass（危机、急症，红线 4）时照常记数、不拦截。不是健管师的会话不计、返回 true。
     * 同一位健管师同一项按咨询锁串行，并发请求不会一起越过额度。
     */
    create function quota_consume(p_metric text, p_n int, p_bypass boolean) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_user uuid := app_user_id(); u users; p plans; v_limit bigint; v_used bigint;
      v_today date := (now() at time zone 'Asia/Shanghai')::date;
    begin
      if p_metric not in ('llm_calls', 'expert_calls', 'report_pages') or p_n is null
        or p_n < 0 or p_n > 10000
      then
        raise exception 'invalid metric' using errcode = 'check_violation';
      end if;
      if app_role() is distinct from 'manager' or v_user is null then return true; end if;
      select * into u from users where id = v_user and role = 'manager' and status = 'active';
      if not found then return true; end if;
      perform pg_advisory_xact_lock(5001, hashtext(v_user::text || ':' || p_metric));
      p := effective_plan(v_user);
      v_limit := (p.monthly_quotas ->> p_metric)::bigint;
      if v_limit is not null and not p_bypass then
        select coalesce(sum(count), 0) into v_used from quota_usage_daily
          where user_id = v_user and metric = p_metric
            and day >= date_trunc('month', v_today)::date;
        if v_used + p_n > v_limit then return false; end if;
      end if;
      insert into quota_usage_daily (user_id, operator_id, org_id, day, metric, count)
        values (v_user, u.operator_id, u.org_id, v_today, p_metric, p_n)
        on conflict (user_id, day, metric) do update
          set count = quota_usage_daily.count + excluded.count,
            operator_id = excluded.operator_id, org_id = excluded.org_id;
      return true;
    end
    $$;

    -- 本月剩余额度（只读预检查，调用模型之前用）；null 为不另设上限
    create function quota_remaining(p_metric text) returns bigint
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_user uuid := app_user_id(); v_limit bigint; v_used bigint;
      v_today date := (now() at time zone 'Asia/Shanghai')::date;
    begin
      if app_role() is distinct from 'manager' or v_user is null then return null; end if;
      v_limit := ((effective_plan(v_user)).monthly_quotas ->> p_metric)::bigint;
      if v_limit is null then return null; end if;
      select coalesce(sum(count), 0) into v_used from quota_usage_daily
        where user_id = v_user and metric = p_metric
          and day >= date_trunc('month', v_today)::date;
      return greatest(v_limit - v_used, 0);
    end
    $$;

    -- 伴侣设备数：本人名下客户已绑定的设备，加上这一台是否超过套餐上限（null 不限）。
    -- 先按健管师拿咨询锁再数，同一事务里接着绑定，并发绑定不会超过上限（租户审查 S3）
    create function quota_companion_device_ok() returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_user uuid := app_user_id(); v_limit bigint;
    begin
      if app_role() is distinct from 'manager' or v_user is null then return true; end if;
      perform pg_advisory_xact_lock(5001, hashtext(v_user::text || ':companion_devices'));
      v_limit := ((effective_plan(v_user)).monthly_quotas ->> 'companion_devices')::bigint;
      if v_limit is null then return true; end if;
      return (select count(*) from companion_devices where manager_id = v_user
        and client_id is not null) < v_limit;
    end
    $$;

    -- 本人的套餐和本月用量（工作台“我的账号”）
    create function my_plan()
      returns table (code text, name text, features jsonb, monthly_quotas jsonb,
        contract_end date, usage jsonb, companion_devices bigint)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_user uuid := app_user_id(); p plans;
      v_today date := (now() at time zone 'Asia/Shanghai')::date;
    begin
      if app_role() is distinct from 'manager' or v_user is null then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      p := effective_plan(v_user);
      return query select p.code, p.name, p.features, p.monthly_quotas,
        (select o.contract_end from users u join operators o on o.id = u.operator_id
          where u.id = v_user),
        coalesce((select jsonb_object_agg(metric, n) from (
          select metric, sum(count) as n from quota_usage_daily
          where user_id = v_user and day >= date_trunc('month', v_today)::date
          group by metric) s), '{}'::jsonb),
        (select count(*) from companion_devices where manager_id = v_user
          and client_id is not null);
    end
    $$;

    -- 功能开关（服务器的守卫用）：本人的套餐是否包含这个功能
    create function plan_feature_enabled(p_feature text) returns boolean
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select coalesce(((effective_plan(app_user_id())).features ->> p_feature)::boolean, false)
    $$;
  `.execute(db);

  for (const fn of [
    'admin_save_plan(uuid, text, text, jsonb, jsonb)',
    'admin_retire_plan(uuid)',
    'admin_set_operator_plans(uuid, uuid[])',
    'admin_assign_plan(uuid, uuid)',
    'quota_consume(text, int, boolean)',
    'quota_companion_device_ok()',
    'quota_remaining(text)',
    'my_plan()',
    'plan_feature_enabled(text)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to ${app}`.execute(db);
  }
  for (const fn of [
    'admin_plan_snapshot(plans)',
    'plan_sellable(uuid, uuid)',
    'effective_plan(uuid)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
  }
}
