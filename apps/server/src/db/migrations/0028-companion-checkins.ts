import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';
import { COMPANION_SCRIPT_KINDS_0027 } from './0027-companion-dialogue.js';

/**
 * M6 伴侣“福宝”第 5 步：打卡（规格 2.3、5.4 第 5 条、6.2、N7、N8、N15）。
 *
 * - checkin_plans：健管师给自己的客户设置（Q16）。服药类不存药名和剂量（N15），note 只给健管师看：
 *   设备会话只经 companion_due_checkins() 读到期的计划，读不到 note。
 * - checkins：一个计划、一天、一个时间段一条。设备不能直接写，只经下面的函数：
 *   companion_checkin_record（服药、运动的回答）、companion_checkin_reading（测量值，客户口头确认后）。
 *   窗口过了没回答的，由定时任务 companion_checkin_sweep 记“未应答”（N7）。
 * - companion_checkin_reading 写监测读数（来源 companion）、标孪生待重算、按平台危急阈值判断，
 *   命中时写一条“危急指标”预警（规格 2.3、2.5）。设备角色对监测、阈值、孪生表都没有权限。
 * - companion_observations：本步只有“待确认的测量”（数值两次超出合理范围，不写监测，给健管师确认）。
 *   信息收集的其他类别、确认和驳回接口在第 6 步。设备只经 companion_pending_reading 写。
 * - 时间段窗口和 packages/shared 的 CHECKIN_SLOT_WINDOWS 一致（有测试对照），按北京时间。
 */

/** 迁移时的时间段窗口快照（有测试对照 CHECKIN_SLOT_WINDOWS） */
export const CHECKIN_SLOT_WINDOWS_0028 = {
  morning: { start: '06:00', end: '11:00' },
  noon: { start: '11:00', end: '14:00' },
  evening: { start: '17:00', end: '20:00' },
  bedtime: { start: '20:00', end: '23:00' },
} as const;

/** 测量项目和监测指标、单位（有测试对照 CHECKIN_METRIC_READINGS 和指标目录） */
export const CHECKIN_METRIC_READINGS_0028 = {
  bp: [
    ['sbp', 'mmHg'],
    ['dbp', 'mmHg'],
  ],
  fpg: [['fpg', 'mmol/L']],
  weight: [['weight', 'kg']],
  steps: [['steps', 'steps']],
  sleep_hours: [['sleep_hours', 'h']],
} as const;

export const COMPANION_SCRIPT_KINDS_0028 = [
  ...COMPANION_SCRIPT_KINDS_0027,
  'checkin_confirm_reading',
  'checkin_recorded',
  'checkin_retry',
  'checkin_noted',
] as const;

/** 新增话术第 1 版（候选，待审定）；有测试对照 COMPANION_DEFAULT_SCRIPTS */
export const COMPANION_SCRIPTS_SNAPSHOT_0028: Readonly<Record<string, string>> = {
  checkin_confirm_reading: '您说的是{reading}，对吗？',
  checkin_recorded: '记下了，我会告诉您的健管师。',
  checkin_retry: '我没记清楚，您再说一遍数好吗？',
  checkin_noted: '好的，记下了。',
};

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
  'care_plans',
  'visits',
  'visit_materials',
  'client_record_consents',
  'visit_records',
  'visit_record_addenda',
  'visit_events',
  'companion_devices',
  'companion_consents',
  'companion_deliveries',
  'companion_sessions',
  'companion_messages',
  'companion_memories',
  'companion_handoffs',
  'companion_alerts',
  'checkin_plans',
  'checkins',
  'companion_observations',
];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

const TENANT_COLUMNS = sql`
  operator_id uuid not null references operators (id),
  org_id uuid,
  manager_id uuid not null,
  client_id uuid not null,
`;
const TENANT_FKS = sql`
  foreign key (client_id, manager_id) references clients (id, manager_id)
    on update cascade on delete cascade,
  foreign key (manager_id, org_id) references users (id, org_id) on update cascade
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  const W = CHECKIN_SLOT_WINDOWS_0028;
  const slots = Object.keys(W);
  const metrics = Object.keys(CHECKIN_METRIC_READINGS_0028);

  // ---------- 1. 新增固定话术 ----------
  await sql`
    alter table companion_scripts drop constraint companion_scripts_kind_check;
    alter table companion_scripts add constraint companion_scripts_kind_check
      check (kind in (${list(COMPANION_SCRIPT_KINDS_0028)}));
    alter table companion_messages drop constraint companion_messages_script_kind_check;
    alter table companion_messages add constraint companion_messages_script_kind_check
      check (script_kind in (${list(COMPANION_SCRIPT_KINDS_0028)}));
  `.execute(db);
  for (const [kind, text] of Object.entries(COMPANION_SCRIPTS_SNAPSHOT_0028)) {
    await sql`insert into companion_scripts (kind, version, text) values (${kind}, 1, ${text})`.execute(
      db,
    );
  }

  // ---------- 2. 时间段窗口 ----------
  // 窗口按北京时间；返回 [开始, 结束)
  const windowCases = (field: 'start' | 'end') =>
    sql.raw(
      Object.entries(W)
        .map(([slot, w]) => `when '${slot}' then time '${w[field]}'`)
        .join(' '),
    );
  await sql`
    create function checkin_slot_start(p_slot text) returns time
      language sql immutable as $$ select case p_slot ${windowCases('start')} end $$;
    create function checkin_slot_end(p_slot text) returns time
      language sql immutable as $$ select case p_slot ${windowCases('end')} end $$;
    -- slots 形如 [{"slot":"morning","time":"08:00"}]：时间段不重复、时间在窗口内
    create function checkin_slots_valid(p_slots jsonb) returns boolean
      language sql immutable as $$
        select jsonb_typeof(p_slots) = 'array'
          and jsonb_array_length(p_slots) between 1 and ${sql.lit(slots.length)}
          and (select count(distinct s ->> 'slot') from jsonb_array_elements(p_slots) s)
            = jsonb_array_length(p_slots)
          and not exists (
            select 1 from jsonb_array_elements(p_slots) s
            where jsonb_typeof(s) <> 'object'
              or (select count(*) from jsonb_object_keys(s)) <> 2
              or s ->> 'slot' is null or s ->> 'slot' not in (${list(slots)})
              or s ->> 'time' is null or s ->> 'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              or (s ->> 'time')::time < checkin_slot_start(s ->> 'slot')
              or (s ->> 'time')::time >= checkin_slot_end(s ->> 'slot')
          )
      $$;
    grant execute on function checkin_slot_start(text), checkin_slot_end(text),
      checkin_slots_valid(jsonb) to ${app};
  `.execute(db);

  // ---------- 3. 表 ----------
  await sql`
    -- 预警可以指向触发它的监测读数（危急指标），复合外键需要 (id, client_id) 唯一
    alter table monitoring_readings add constraint monitoring_readings_id_client_key
      unique (id, client_id);

    create table checkin_plans (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      kind text not null check (kind in ('medication', 'measurement', 'exercise')),
      metric text check (metric in (${list(metrics)})),
      slots jsonb not null check (checkin_slots_valid(slots)),
      goal_template_id uuid references plan_goal_templates (id),
      -- 只给健管师看（设备读不到）；服药类不存药名字段（N15）
      note text check (char_length(note) between 1 and 200),
      active boolean not null default true,
      created_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((kind = 'measurement') = (metric is not null)),
      check (kind = 'exercise' or goal_template_id is null),
      unique (id, client_id),
      ${TENANT_FKS}
    );
    create index checkin_plans_client_idx on checkin_plans (client_id, created_at);

    create table checkins (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      plan_id uuid not null,
      due_on date not null,
      slot text not null check (slot in (${list(slots)})),
      status text not null check (status in ('done', 'partial', 'missed', 'skipped', 'no_response')),
      -- 测量类：客户报的数值（血压是高压、低压）；写进监测的是同样的数
      reading_values numeric(12, 3)[] not null default '{}',
      answered_at timestamptz,
      created_at timestamptz not null default now(),
      unique (plan_id, due_on, slot),
      check ((status = 'no_response') = (answered_at is null)),
      foreign key (plan_id, client_id) references checkin_plans (id, client_id) on delete cascade,
      ${TENANT_FKS}
    );
    create index checkins_client_idx on checkins (client_id, due_on desc);

    create table companion_observations (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      category text not null check (category in
        ('diet', 'sleep', 'exercise', 'mood', 'adherence', 'body', 'life', 'measurement')),
      text text not null check (char_length(text) between 1 and 200),
      observed_on date not null,
      metric text check (metric in (${list(metrics)})),
      reading_values numeric(12, 3)[] not null default '{}',
      source_message_id bigint,
      status text not null default 'info'
        check (status in ('info', 'pending_confirm', 'confirmed', 'dismissed')),
      created_at timestamptz not null default now(),
      check (category = 'measurement' or (metric is null and cardinality(reading_values) = 0)),
      foreign key (source_message_id, client_id) references companion_messages (id, client_id)
        on delete set null (source_message_id),
      ${TENANT_FKS}
    );
    create index companion_observations_client_idx
      on companion_observations (client_id, created_at desc);
    create index companion_observations_manager_pending_idx
      on companion_observations (manager_id) where status = 'pending_confirm';

    -- 危急指标预警指向触发它的读数
    alter table companion_alerts add column reading_id bigint;
    alter table companion_alerts add constraint companion_alerts_reading_fk
      foreign key (reading_id, client_id) references monitoring_readings (id, client_id)
      on delete set null (reading_id);
  `.execute(db);

  // ---------- 4. 行级安全 ----------
  const manager = sql`app_role() = 'manager' and manager_id = app_user_id()`;
  for (const table of ['checkin_plans', 'checkins', 'companion_observations']) {
    const t = sql.table(table);
    const p = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`
      alter table ${t} enable row level security;
      create trigger ${p('tenant')} before insert or update on ${t}
        for each row execute function client_record_tenant();
      create policy ${p('manager_select')} on ${t} for select using (${manager});
    `.execute(db);
  }
  await sql`
    create policy checkin_plans_manager_insert on checkin_plans for insert
      with check (app_role() = 'manager' and manager_id = app_user_id() and created_by = app_user_id());
    create policy checkin_plans_manager_update on checkin_plans for update
      using (${manager}) with check (${manager});

    -- 计划的类别、测量项目、客户、创建人不能改（改了就是另一个计划）
    create function checkin_plans_guard() returns trigger
      language plpgsql set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if new.kind is distinct from old.kind or new.metric is distinct from old.metric
        or new.client_id is distinct from old.client_id
        or new.created_by is distinct from old.created_by
        or new.created_at is distinct from old.created_at then
        raise exception 'checkin plan identity is immutable' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger checkin_plans_guard before update on checkin_plans
      for each row execute function checkin_plans_guard();

    grant select on checkin_plans to ${app};
    grant insert (client_id, kind, metric, slots, goal_template_id, note, created_by)
      on checkin_plans to ${app};
    grant update (slots, goal_template_id, note, active) on checkin_plans to ${app};
    grant select on checkins, companion_observations to ${app};
  `.execute(db);

  // ---------- 5. 设备会话的打卡函数 ----------
  // 都以 app_client_id() 和 companion_device_can_talk() 为准：暂停、撤回同意后什么都写不了；
  // 计划必须是这位客户的、启用的，时间段必须在计划里、今天到了提醒时间、窗口还没结束
  const units = sql.raw(
    Object.values(CHECKIN_METRIC_READINGS_0028)
      .flat()
      .map(([code, unit]) => `when '${code}' then '${unit}'`)
      .join(' '),
  );
  const codes = sql.raw(
    Object.entries(CHECKIN_METRIC_READINGS_0028)
      .map(
        ([metric, rs]) =>
          `when '${metric}' then array[${rs.map(([code]) => `'${code}'`).join(', ')}]`,
      )
      .join(' '),
  );
  await sql`
    create function checkin_local_now() returns timestamp
      language sql stable as $$ select now() at time zone 'Asia/Shanghai' $$;
    create function checkin_metric_codes(p_metric text) returns text[]
      language sql immutable as $$ select case p_metric ${codes} end $$;
    create function checkin_metric_unit(p_code text) returns text
      language sql immutable as $$ select case p_code ${units} end $$;

    -- 今天到期、还没打卡的计划和时间段（按提醒时间排序），给福宝补说提醒
    create function companion_due_checkins()
      returns table (plan_id uuid, kind text, metric text, slot text, remind_at time)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select p.id, p.kind, p.metric, s ->> 'slot', (s ->> 'time')::time
        from checkin_plans p, jsonb_array_elements(p.slots) s
        where p.client_id = app_client_id() and companion_device_can_talk() and p.active
          and checkin_local_now()::time >= (s ->> 'time')::time
          and checkin_local_now()::time < checkin_slot_end(s ->> 'slot')
          and not exists (
            select 1 from checkins c
              where c.plan_id = p.id and c.due_on = checkin_local_now()::date
                and c.slot = s ->> 'slot'
          )
        order by (s ->> 'time')::time, p.created_at, p.id
    $$;

    -- 今天的打卡情况（给福宝的资料，规格 5.2）：计划的类别、项目、时间段、结果和客户报的数，
    -- 不含备注；还没到提醒时间的时间段不列
    create function companion_today_checkins()
      returns table (kind text, metric text, slot text, status text, reading_values numeric[])
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select p.kind, p.metric, s ->> 'slot', c.status, coalesce(c.reading_values, '{}')
        from checkin_plans p
        cross join jsonb_array_elements(p.slots) s
        left join checkins c on c.plan_id = p.id and c.slot = s ->> 'slot'
          and c.due_on = checkin_local_now()::date
        where p.client_id = app_client_id() and companion_device_can_talk() and p.active
          and (c.id is not null or checkin_local_now()::time >= (s ->> 'time')::time)
        order by (s ->> 'time')::time, p.created_at, p.id
    $$;

    -- 校验设备能给这个计划的这个时间段打卡，返回计划
    create function companion_checkin_plan(p_plan uuid, p_slot text) returns checkin_plans
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v checkin_plans;
    begin
      select * into v from checkin_plans p
        where p.id = p_plan and p.client_id = app_client_id() and companion_device_can_talk()
          and p.active
          and exists (
            select 1 from jsonb_array_elements(p.slots) s
              where s ->> 'slot' = p_slot
                and checkin_local_now()::time >= (s ->> 'time')::time
                and checkin_local_now()::time < checkin_slot_end(p_slot)
          );
      if not found then
        raise exception 'checkin not due' using errcode = '42501';
      end if;
      return v;
    end
    $$;

    -- 服药、运动的回答
    create function companion_checkin_record(p_plan uuid, p_slot text, p_status text)
      returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v checkin_plans;
      v_id uuid;
    begin
      v := companion_checkin_plan(p_plan, p_slot);
      if v.kind = 'measurement'
        or (v.kind = 'medication' and p_status not in ('done', 'missed', 'skipped'))
        or (v.kind = 'exercise' and p_status not in ('done', 'partial', 'missed')) then
        raise exception 'invalid checkin status' using errcode = 'check_violation';
      end if;
      insert into checkins (client_id, plan_id, due_on, slot, status, answered_at)
        values (v.client_id, v.id, checkin_local_now()::date, p_slot, p_status, now())
        on conflict (plan_id, due_on, slot) do nothing
        returning id into v_id;
      return v_id;
    end
    $$;

    -- 测量值（客户已口头确认）：合理范围由调用方先校验，这里再按目录单位写监测、判断危急阈值。
    -- 返回打卡 id、写入的读数 id、命中危急阈值的读数 id（没有命中为空）
    create function companion_checkin_reading(p_plan uuid, p_slot text, p_values numeric[])
      returns table (checkin_id uuid, reading_ids bigint[], critical_reading_id bigint)
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v checkin_plans;
      v_codes text[];
      v_id uuid;
      v_reading bigint;
      v_readings bigint[] := '{}';
      v_critical bigint;
      v_now timestamptz := now();
    begin
      v := companion_checkin_plan(p_plan, p_slot);
      if v.kind <> 'measurement' then
        raise exception 'not a measurement plan' using errcode = 'check_violation';
      end if;
      v_codes := checkin_metric_codes(v.metric);
      if cardinality(p_values) <> cardinality(v_codes)
        or exists (select 1 from unnest(p_values) x where x is null) then
        raise exception 'invalid reading values' using errcode = 'check_violation';
      end if;
      insert into checkins (client_id, plan_id, due_on, slot, status, reading_values, answered_at)
        values (v.client_id, v.id, checkin_local_now()::date, p_slot, 'done', p_values, v_now)
        on conflict (plan_id, due_on, slot) do nothing
        returning id into v_id;
      if v_id is null then
        -- 已经打过卡（同一时间段重复报）：不再写监测
        return query select null::uuid, '{}'::bigint[], null::bigint;
        return;
      end if;
      for i in 1 .. cardinality(v_codes) loop
        insert into monitoring_readings (client_id, metric, value, unit, measured_at, source)
          values (v.client_id, v_codes[i], p_values[i], checkin_metric_unit(v_codes[i]), v_now,
            'companion')
          returning id into v_reading;
        v_readings := v_readings || v_reading;
        if v_critical is null and exists (
          select 1 from critical_thresholds t
            where t.enabled and t.metric = v_codes[i]
              and case t.comparator
                when 'gte' then p_values[i] >= t.value
                when 'gt' then p_values[i] > t.value
                when 'lte' then p_values[i] <= t.value
                when 'lt' then p_values[i] < t.value
              end
        ) then
          v_critical := v_reading;
        end if;
      end loop;
      -- 孪生待重算（M4 2.4）；入队由后端在函数返回后做
      insert into twin_compute_state (client_id, operator_id, org_id, manager_id, requested_at)
        select c.id, c.operator_id, c.org_id, c.manager_id, v_now from clients c
          where c.id = v.client_id
        on conflict (client_id) do update set requested_at = excluded.requested_at;
      if v_critical is not null then
        insert into companion_alerts (client_id, category, trigger, reading_id, script_version)
          values (v.client_id, 'critical_value', 'threshold', v_critical, (
            select max(version) from companion_scripts where kind = 'critical_value'
          ));
      end if;
      return query select v_id, v_readings, v_critical;
    end
    $$;

    -- 数值两次超出合理范围：不写监测，记一条待确认的测量给健管师（规格 2.3）
    create function companion_pending_reading(p_metric text, p_values numeric[], p_text text,
      p_message bigint)
      returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_client uuid := app_client_id();
      v_id uuid;
    begin
      if v_client is null or not companion_device_can_talk() then
        raise exception 'device cannot write' using errcode = '42501';
      end if;
      if p_message is not null and not exists (
        select 1 from companion_messages m where m.id = p_message and m.client_id = v_client
      ) then
        raise exception 'message not found' using errcode = '42501';
      end if;
      insert into companion_observations
        (client_id, category, text, observed_on, metric, reading_values, source_message_id, status)
        values (v_client, 'measurement', p_text, checkin_local_now()::date, p_metric,
          coalesce(p_values, '{}'), p_message, 'pending_confirm')
        returning id into v_id;
      return v_id;
    end
    $$;

    -- 定时任务（没有租户上下文）：窗口已经结束、没有回答的记“未应答”（N7）。
    -- 只记设备已开通的客户；计划在窗口开始前就已建立、启用；看今天和昨天（任务停过时补上）
    create function companion_checkin_sweep() returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      n int;
    begin
      if app_role() is not null then
        raise exception 'checkin sweep only without tenant context' using errcode = '42501';
      end if;
      insert into checkins (client_id, plan_id, due_on, slot, status)
        select p.client_id, p.id, d.day, s ->> 'slot', 'no_response'
          from checkin_plans p
          cross join jsonb_array_elements(p.slots) s
          cross join (values (checkin_local_now()::date), (checkin_local_now()::date - 1)) d (day)
          where p.active
            and exists (
              select 1 from companion_devices dv
                where dv.client_id = p.client_id and dv.status = 'active'
            )
            and d.day + checkin_slot_end(s ->> 'slot') <= checkin_local_now()
            and (p.created_at at time zone 'Asia/Shanghai')
              <= d.day + (s ->> 'time')::time
        on conflict (plan_id, due_on, slot) do nothing;
      get diagnostics n = row_count;
      return n;
    end
    $$;

    revoke all on function checkin_local_now(), checkin_metric_codes(text),
      checkin_metric_unit(text), companion_due_checkins(), companion_today_checkins(),
      companion_checkin_plan(uuid, text),
      companion_checkin_record(uuid, text, text), companion_checkin_reading(uuid, text, numeric[]),
      companion_pending_reading(text, numeric[], text, bigint), companion_checkin_sweep()
      from public;
    grant execute on function companion_due_checkins(), companion_today_checkins(),
      companion_checkin_record(uuid, text, text),
      companion_checkin_reading(uuid, text, numeric[]),
      companion_pending_reading(text, numeric[], text, bigint), companion_checkin_sweep()
      to ${app};
  `.execute(db);

  // ---------- 6. 客户换机构时同步新表的租户列 ----------
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
