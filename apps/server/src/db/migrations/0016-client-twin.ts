import { sql, type Kysely } from 'kysely';
import { DEFAULT_TWIN_STATUS_RULES } from '@health-buddy/shared';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M4 客户数字孪生（规格 7.1、7.2）：监测数据补租户列，新增状态规则、状态历史、预测和跟进清单。
 *
 * 隔离模型（沿用 0008 的客户档案）：
 * - 客户相关的新表都带 operator_id、org_id、manager_id、client_id，策略直接比较本表的列；
 *   租户列由 client_record_tenant() 从客户行取，客户转出时跟着客户走（Q23），删除时级联删除。
 * - 健管师：只看自己客户的数据。状态历史、预测只能追加（预测只放行 superseded_at 从空变为有值）。
 * - 机构管理员：只读本机构的监测数据和状态历史（Q20）；看不到预测和跟进清单。
 * - 运营商、平台管理员：没有任何客户相关的策略。
 * - 状态规则全平台一套（Q1）：平台管理员可读写，其余角色只读；每次修改由触发器记录并把版本号加一。
 */

/**
 * 迁移时的指标目录快照：方面、来源、指标、目录单位、合理范围。
 * 迁移发布后不能改，所以这里写成字面量；以后目录变了要另加迁移（有测试对照 packages/shared）。
 */
export const TWIN_RULE_METRICS_SNAPSHOT = [
  ['metabolic', 'report', 'fpg', 'mmol/L', 1, 40],
  ['metabolic', 'report', 'hba1c', '%', 3, 20],
  ['metabolic', 'report', 'tc', 'mmol/L', 1, 20],
  ['metabolic', 'report', 'tg', 'mmol/L', 0.1, 50],
  ['metabolic', 'report', 'ldl_c', 'mmol/L', 0.1, 15],
  ['metabolic', 'report', 'hdl_c', 'mmol/L', 0.1, 5],
  ['metabolic', 'report', 'uric_acid', 'umol/L', 50, 1500],
  ['metabolic', 'monitoring', 'fpg', 'mmol/L', 1, 40],
  ['cardiovascular', 'report', 'sbp', 'mmHg', 50, 300],
  ['cardiovascular', 'report', 'dbp', 'mmHg', 30, 200],
  ['cardiovascular', 'monitoring', 'sbp', 'mmHg', 50, 300],
  ['cardiovascular', 'monitoring', 'dbp', 'mmHg', 30, 200],
  ['cardiovascular', 'monitoring', 'heart_rate', 'bpm', 20, 250],
  ['sleep', 'monitoring', 'sleep_hours', 'h', 0, 24],
  ['weight', 'report', 'weight', 'kg', 20, 300],
  ['weight', 'report', 'bmi', 'kg/m2', 10, 70],
  ['weight', 'report', 'waist', 'cm', 30, 200],
  ['weight', 'monitoring', 'weight', 'kg', 20, 300],
] as const;

const DOMAINS = `'metabolic', 'cardiovascular', 'sleep', 'weight'`;
/** 客户相关的表，客户换机构时同步租户列（沿用 0009 的列表，加上本迁移的表） */
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
];

function literal(v: string | number): string {
  return typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  // ---------- 1. monitoring_readings 补租户列（7.1） ----------
  // 原来是 0003 的“exists 查 clients”策略；改为和 M2 档案一样直接比较本表的列。
  await sql`
    alter table monitoring_readings
      add column operator_id uuid references operators (id),
      add column org_id uuid,
      add column manager_id uuid,
      -- 手动录入的健管师（Q29）；合成、设备、伴侣数据为空
      add column created_by uuid references users (id);
    update monitoring_readings r
      set operator_id = c.operator_id, org_id = c.org_id, manager_id = c.manager_id
      from clients c where c.id = r.client_id;
    alter table monitoring_readings
      alter column operator_id set not null,
      alter column manager_id set not null,
      add foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      add foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      add constraint monitoring_readings_created_by check (created_by is null or source = 'manual');
    create index monitoring_readings_manager_idx on monitoring_readings (manager_id);
    create index monitoring_readings_org_idx on monitoring_readings (org_id);

    drop policy monitoring_readings_select on monitoring_readings;
    drop policy monitoring_readings_write on monitoring_readings;
    create policy monitoring_readings_manager on monitoring_readings for all
      using (app_role() = 'manager' and manager_id = app_user_id())
      with check (
        app_role() = 'manager' and manager_id = app_user_id()
        and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
      );
    create policy monitoring_readings_org_admin_select on monitoring_readings for select
      using (app_role() = 'org_admin' and org_id = app_org_id());
    create trigger monitoring_readings_tenant before insert or update on monitoring_readings
      for each row execute function client_record_tenant();

    -- 应用只能以本人名义手动录入；只能删除自己手动录入的读数（合成、伴侣、设备数据不能删）。
    -- 读数不能修改，录错了删掉重录。系统操作（合成数据脚本、级联）除外。
    create function monitoring_readings_guard() returns trigger language plpgsql as $$
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
        return new;
      end if;
      if old.source <> 'manual' or old.created_by is distinct from app_user_id() then
        raise exception 'only own manual readings can be deleted' using errcode = 'check_violation';
      end if;
      return old;
    end
    $$;
    create trigger monitoring_readings_guard before insert or delete on monitoring_readings
      for each row execute function monitoring_readings_guard();

    revoke update on monitoring_readings from ${app};
  `.execute(db);

  // ---------- 2. 状态规则（2.10、7.2） ----------
  const metricTuples = TWIN_RULE_METRICS_SNAPSHOT.map(
    ([d, s, m]) => `(${literal(d)}, ${literal(s)}, ${literal(m)})`,
  ).join(', ');
  const monitoringMetrics = TWIN_RULE_METRICS_SNAPSHOT.filter(([, s]) => s === 'monitoring');
  const unitCase = monitoringMetrics
    .map(([, , m, u]) => `when ${literal(m)} then ${literal(u)}`)
    .join(' ');
  const boundsCase = (i: 4 | 5) =>
    monitoringMetrics.map((row) => `when ${literal(row[2])} then ${row[i]}`).join(' ');

  await sql`
    create table twin_status_rules (
      id uuid primary key default gen_random_uuid(),
      domain text not null check (domain in (${sql.raw(DOMAINS)})),
      metric text not null,
      source text not null check (source in ('report', 'monitoring')),
      method text not null check (method in ('critical', 'out_of_reference', 'threshold')),
      comparator text check (comparator in ('gte', 'gt', 'lte', 'lt')),
      value numeric(12, 3),
      unit text,
      window_days int check (window_days between 1 and 90),
      level text not null check (level in ('red', 'yellow')),
      enabled boolean not null default true,
      updated_by uuid references users (id),
      updated_at timestamptz not null default now(),
      -- 指标只能从目录里选，且属于这个方面（4.1）
      constraint twin_status_rules_metric check ((domain, source, metric) in (${sql.raw(metricTuples)})),
      constraint twin_status_rules_method_source check (
        (method <> 'out_of_reference' or source = 'report')
        and (method <> 'threshold' or source = 'monitoring')
      ),
      -- 固定阈值类必须有比较方式、阈值和单位；其余类型都没有
      constraint twin_status_rules_threshold check (
        (method = 'threshold' and comparator is not null and value is not null and unit is not null)
        or (method <> 'threshold' and comparator is null and value is null and unit is null)
      ),
      constraint twin_status_rules_window check ((source = 'monitoring') = (window_days is not null)),
      unique nulls not distinct (domain, metric, source, method, comparator, level)
    );

    -- 规则整体的版本号（单行），每个修改规则的事务加一
    create table twin_rules_version (
      id boolean primary key default true check (id),
      version int not null default 1,
      updated_at timestamptz not null default now(),
      bumped_xact xid8
    );
    insert into twin_rules_version default values;

    create table twin_status_rule_events (
      id bigint generated always as identity primary key,
      rule_id uuid not null,
      actor_id uuid references users (id),
      action text not null check (action in ('created', 'updated', 'deleted', 'reset')),
      before jsonb,
      after jsonb,
      rules_version int not null,
      created_at timestamptz not null default now()
    );
    create index twin_status_rule_events_created_idx on twin_status_rule_events (created_at);

    -- 单位跟目录走、阈值在合理范围内（7.2：check + 触发器）
    create function twin_status_rules_guard() returns trigger language plpgsql as $$
    begin
      if new.method = 'threshold' then
        if new.unit is distinct from (case new.metric ${sql.raw(unitCase)} end) then
          raise exception 'unit must follow the catalog' using errcode = 'check_violation';
        end if;
        if new.value < (case new.metric ${sql.raw(boundsCase(4))} end)
          or new.value > (case new.metric ${sql.raw(boundsCase(5))} end)
        then
          raise exception 'threshold out of range' using errcode = 'check_violation';
        end if;
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger twin_status_rules_guard before insert or update on twin_status_rules
      for each row execute function twin_status_rules_guard();
  `.execute(db);

  // 默认规则（第五节之二，待医学顾问审定）。在审计触发器之前写入，初始版本号为 1
  // M6 的条数规则（来源 companion）由 0031 在扩展规则表之后写入
  for (const r of DEFAULT_TWIN_STATUS_RULES.filter((x) => x.source !== 'companion')) {
    await sql`
      insert into twin_status_rules
        (domain, metric, source, method, comparator, value, unit, window_days, level)
      values (${r.domain}, ${r.metric}, ${r.source}, ${r.method}, ${r.comparator}, ${r.value},
              ${r.unit}, ${r.windowDays}, ${r.level})
    `.execute(db);
  }

  // 修改记录和版本号由触发器写入，应用角色不能直接写，也就不能伪造或漏记。
  // 规则不是客户数据，可以记改前改后的数值。
  await sql`
    create function twin_status_rules_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      rule_fields text[] := array['domain', 'metric', 'source', 'method', 'comparator', 'value',
                                  'unit', 'window_days', 'level', 'enabled'];
      b jsonb;
      a jsonb;
      v int;
    begin
      -- 同一个事务里的多次修改（如恢复默认值）只加一次版本号
      update twin_rules_version
        set version = version + 1, updated_at = now(), bumped_xact = pg_current_xact_id()
        where bumped_xact is distinct from pg_current_xact_id();
      select version into v from twin_rules_version;
      if tg_op <> 'INSERT' then
        select jsonb_object_agg(k, x) into b from jsonb_each(to_jsonb(old)) as e(k, x)
          where k = any (rule_fields);
      end if;
      if tg_op <> 'DELETE' then
        select jsonb_object_agg(k, x) into a from jsonb_each(to_jsonb(new)) as e(k, x)
          where k = any (rule_fields);
      end if;
      insert into twin_status_rule_events (rule_id, actor_id, action, before, after, rules_version)
        values (
          coalesce(new.id, old.id),
          app_user_id(),
          case
            -- 只有 twin_status_rules_reset 能写标记表（应用角色没有任何权限），应用自己设不了
            when exists (
              select 1 from twin_rules_reset_marker m where m.xact = pg_current_xact_id()
            ) then 'reset'
            when tg_op = 'INSERT' then 'created'
            when tg_op = 'UPDATE' then 'updated'
            else 'deleted'
          end,
          b,
          a,
          v
        );
      return coalesce(new, old);
    end
    $$;
    revoke all on function twin_status_rules_audit() from public;
    create trigger twin_status_rules_audit after insert or update or delete on twin_status_rules
      for each row execute function twin_status_rules_audit();

    -- 恢复为默认值（2.10）的标记：当前事务在恢复默认值。应用角色没有任何权限，
    -- 只有下面以所有者身份执行的函数能写，所以修改记录里的 reset 不能被伪造。
    create table twin_rules_reset_marker (xact xid8 primary key);
    alter table twin_rules_reset_marker enable row level security;

    -- 恢复为默认值：只有平台管理员能调用；修改记录标为 reset，版本号只加一次。
    -- 以所有者身份执行（要写标记表），所以在这里显式校验角色，并以调用者名义记 updated_by。
    -- 默认规则由后端从 packages/shared 传入，形状、单位和范围仍由 check 和触发器校验。
    create function twin_status_rules_reset(p_rules jsonb) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'platform_admin' or app_user_id() is null then
        raise exception 'only the platform admin can reset rules' using errcode = 'insufficient_privilege';
      end if;
      if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
        raise exception 'reset needs a non-empty rule list' using errcode = 'invalid_parameter_value';
      end if;
      insert into twin_rules_reset_marker (xact) values (pg_current_xact_id())
        on conflict do nothing;
      delete from twin_status_rules;
      insert into twin_status_rules
        (domain, metric, source, method, comparator, value, unit, window_days, level, updated_by)
        select r.domain, r.metric, r.source, r.method, r.comparator, r.value, r.unit,
               r.window_days, r.level, app_user_id()
        from jsonb_to_recordset(p_rules) as r(domain text, metric text, source text, method text,
          comparator text, value numeric, unit text, window_days int, level text);
      delete from twin_rules_reset_marker where xact = pg_current_xact_id();
    end
    $$;
    revoke all on function twin_status_rules_reset(jsonb) from public;

    alter table twin_status_rules enable row level security;
    alter table twin_rules_version enable row level security;
    alter table twin_status_rule_events enable row level security;
    create policy twin_status_rules_select on twin_status_rules for select
      using (app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager'));
    create policy twin_status_rules_write on twin_status_rules for all
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());
    create policy twin_rules_version_select on twin_rules_version for select
      using (app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager'));
    create policy twin_status_rule_events_select on twin_status_rule_events for select
      using (app_role() = 'platform_admin');

    grant select, insert, update, delete on twin_status_rules to ${app};
    grant select on twin_rules_version, twin_status_rule_events to ${app};
    grant execute on function twin_status_rules_reset(jsonb) to ${app};
  `.execute(db);

  // ---------- 3. 状态历史、预测、跟进清单（7.2） ----------
  await sql`
    create table twin_status_history (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      domain text not null check (domain in (${sql.raw(DOMAINS)})),
      level text not null check (level in ('red', 'yellow', 'green', 'unknown')),
      origin text not null check (origin in ('computed', 'manual', 'manual_cleared')),
      -- 依据含健康数值，只存数据库，不进日志
      basis jsonb not null default '[]' check (jsonb_typeof(basis) = 'array'),
      rules_version int not null check (rules_version >= 0),
      reason text check (char_length(reason) <= 500),
      manual_expires text check (manual_expires in ('next_data', 'never')),
      trigger text not null check (trigger in ('report_verified', 'correction', 'monitoring',
        'rules_changed', 'thresholds_changed', 'manual', 'seed')),
      set_by uuid references users (id),
      created_at timestamptz not null default clock_timestamp(),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      -- 手动调整必须有理由（不少于 5 个字）、失效方式和调整人，且只能调成红黄绿（Q4）
      constraint twin_status_history_origin check (
        (origin = 'manual' and trigger = 'manual' and level <> 'unknown' and set_by is not null
          and reason is not null and char_length(btrim(reason)) >= 5 and manual_expires is not null)
        or (origin = 'manual_cleared' and trigger = 'manual' and set_by is not null
          and manual_expires is null)
        or (origin = 'computed' and trigger <> 'manual' and set_by is null and reason is null
          and manual_expires is null)
      )
    );
    -- 最新一行就是当前状态
    create index twin_status_history_client_idx
      on twin_status_history (client_id, domain, created_at desc, id desc);
    create index twin_status_history_manager_idx on twin_status_history (manager_id);
    create index twin_status_history_org_idx on twin_status_history (org_id);

    create table twin_forecasts (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      metric text not null check (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
      source text not null check (source in ('report', 'monitoring')),
      method_version text not null check (char_length(method_version) between 1 and 40),
      horizon_months smallint check (horizon_months in (3, 6)),
      -- 预测点：日期、中间值、区间下限、上限
      points jsonb not null default '[]' check (jsonb_typeof(points) = 'array'),
      -- 依据（数据起止、预测起点）和拟合参数，偏离判断用（6.4）
      basis jsonb check (jsonb_typeof(basis) = 'object'),
      fit jsonb check (jsonb_typeof(fit) = 'object'),
      interval_level numeric(3, 2) not null default 0.8,
      n_points int not null check (n_points >= 0),
      span_days int not null check (span_days >= 0),
      uncertainty text check (uncertainty in ('normal', 'high')),
      status text not null check (status in ('ok', 'insufficient_data')),
      insufficient_reason text
        check (insufficient_reason in ('not_forecastable', 'too_few_points', 'span_too_short')),
      points_needed int check (points_needed > 0),
      computed_at timestamptz not null default clock_timestamp(),
      superseded_at timestamptz,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint twin_forecasts_status check (
        (status = 'ok' and horizon_months is not null and uncertainty is not null
          and insufficient_reason is null and basis is not null and fit is not null
          and jsonb_array_length(points) > 0)
        or (status = 'insufficient_data' and horizon_months is null and uncertainty is null
          and insufficient_reason is not null and jsonb_array_length(points) = 0)
      )
    );
    -- 每个指标每个来源只有一条当前预测；新预测写入前先把旧的标为被替代
    create unique index twin_forecasts_current
      on twin_forecasts (client_id, metric, source) where superseded_at is null;
    create index twin_forecasts_client_idx
      on twin_forecasts (client_id, metric, source, computed_at desc);
    create index twin_forecasts_manager_idx on twin_forecasts (manager_id);

    create table follow_up_items (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      kind text not null
        check (kind in ('critical', 'status_red', 'status_worsened', 'forecast_deviation')),
      severity smallint not null check (severity between 1 and 4),
      domain text check (domain in (${sql.raw(DOMAINS)})),
      metric text check (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
      basis jsonb not null default '{}' check (jsonb_typeof(basis) = 'object'),
      source_ref jsonb not null default '{}' check (jsonb_typeof(source_ref) = 'object'),
      dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
      status text not null default 'open' check (status in ('open', 'done', 'snoozed', 'dismissed')),
      snooze_until timestamptz,
      resolution text
        check (resolution in ('called', 'recheck_arranged', 'referred', 'plan_adjusted', 'other')),
      dismiss_reason text check (dismiss_reason in ('data_error', 'known', 'under_care', 'other')),
      note text check (char_length(note) <= 500),
      first_triggered_at timestamptz not null default now(),
      last_triggered_at timestamptz not null default now(),
      resolved_by uuid references users (id),
      resolved_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint follow_up_items_target check (domain is not null or metric is not null),
      -- 严重程度和类型对应（2.6、Q15）
      constraint follow_up_items_severity check (
        (kind = 'critical' and severity in (1, 2))
        or (kind = 'status_red' and severity = 2)
        or (kind = 'status_worsened' and severity = 3)
        or (kind = 'forecast_deviation' and severity in (3, 4))
      ),
      -- 危急类不能忽略（Q14）
      constraint follow_up_items_critical_not_dismissed
        check (not (kind = 'critical' and status = 'dismissed')),
      constraint follow_up_items_state check (
        (status = 'open' and snooze_until is null and resolution is null and dismiss_reason is null
          and resolved_by is null and resolved_at is null)
        or (status = 'snoozed' and snooze_until is not null and resolution is null
          and dismiss_reason is null and resolved_by is null and resolved_at is null)
        or (status = 'done' and snooze_until is null and dismiss_reason is null
          and resolved_by is not null and resolved_at is not null)
        or (status = 'dismissed' and snooze_until is null and resolution is null
          and dismiss_reason is not null and resolved_by is not null and resolved_at is not null)
      )
    );
    -- 同一客户、同一类型、同一指标（或方面）未处理时不重复生成
    create unique index follow_up_items_dedupe
      on follow_up_items (client_id, dedupe_key) where status in ('open', 'snoozed');
    create index follow_up_items_manager_idx
      on follow_up_items (manager_id, status, severity, last_triggered_at desc);
    create index follow_up_items_client_idx on follow_up_items (client_id, created_at desc);
    create index follow_up_items_org_idx on follow_up_items (org_id);

    -- 只记谁在什么时候做了什么，不记备注原文和数值
    create table follow_up_events (
      id bigint generated always as identity primary key,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      item_id uuid not null,
      -- 系统生成和重新触发时为空
      actor_id uuid references users (id),
      action text not null check (action in ('created', 'retriggered', 'done', 'snoozed',
        'dismissed', 'reopened', 'consulted')),
      created_at timestamptz not null default clock_timestamp(),
      foreign key (item_id, client_id) references follow_up_items (id, client_id) on delete cascade,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index follow_up_events_item_idx on follow_up_events (item_id, created_at);
    create index follow_up_events_client_idx on follow_up_events (client_id, created_at);
    create index follow_up_events_manager_idx on follow_up_events (manager_id);
  `.execute(db);

  // 行级安全
  for (const table of [
    'twin_status_history',
    'twin_forecasts',
    'follow_up_items',
    'follow_up_events',
  ]) {
    const t = sql.table(table);
    await sql`
      alter table ${t} enable row level security;
      create trigger ${sql.id(`${table}_tenant`)} before insert or update on ${t}
        for each row execute function client_record_tenant();
    `.execute(db);
  }
  const managerUsing = sql`app_role() = 'manager' and manager_id = app_user_id()`;
  const managerCheck = sql`
    app_role() = 'manager' and manager_id = app_user_id()
    and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
  `;
  await sql`
    -- 状态历史：健管师读和追加（计算任务在健管师上下文里写，手动调整也是追加）；机构管理员只读（Q20）
    create policy twin_status_history_manager_select on twin_status_history for select
      using (${managerUsing});
    create policy twin_status_history_manager_insert on twin_status_history for insert
      with check (${managerCheck});
    create policy twin_status_history_org_admin_select on twin_status_history for select
      using (app_role() = 'org_admin' and org_id = app_org_id());

    -- 预测：健管师读、追加、标记被替代；机构管理员看不到（Q20）
    create policy twin_forecasts_manager_select on twin_forecasts for select using (${managerUsing});
    create policy twin_forecasts_manager_insert on twin_forecasts for insert
      with check (${managerCheck});
    create policy twin_forecasts_manager_update on twin_forecasts for update
      using (${managerUsing}) with check (${managerCheck});

    -- 跟进清单：只有健管师本人（Q20：机构管理员看不到）
    create policy follow_up_items_manager on follow_up_items for all
      using (${managerUsing}) with check (${managerCheck});
    create policy follow_up_events_manager_select on follow_up_events for select
      using (${managerUsing});
    create policy follow_up_events_manager_insert on follow_up_events for insert
      with check (${managerCheck});
  `.execute(db);

  // 触发器：只能追加、只放行被替代标记、跟进项的状态机和处理记录
  await sql`
    create function twin_status_history_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.set_by is not null and new.set_by is distinct from app_user_id() then
        raise exception 'status must be set by the current user' using errcode = 'check_violation';
      end if;
      new.created_at := clock_timestamp();
      return new;
    end
    $$;
    create trigger twin_status_history_guard before insert on twin_status_history
      for each row execute function twin_status_history_guard();
    create trigger twin_status_history_append_only before update or delete on twin_status_history
      for each row execute function append_only();

    create function twin_forecasts_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.superseded_at is not null then
          raise exception 'new forecast cannot be superseded' using errcode = 'check_violation';
        end if;
        new.computed_at := clock_timestamp();
        return new;
      end if;
      -- 只放行 superseded_at 从空变为有值，其余内容不变
      if old.superseded_at is not null or new.superseded_at is null
        or (to_jsonb(new) - 'superseded_at') <> (to_jsonb(old) - 'superseded_at')
      then
        raise exception 'forecast is immutable' using errcode = 'check_violation';
      end if;
      new.superseded_at := clock_timestamp();
      return new;
    end
    $$;
    create trigger twin_forecasts_guard before insert or update on twin_forecasts
      for each row execute function twin_forecasts_guard();
    create trigger twin_forecasts_no_delete before delete on twin_forecasts
      for each row execute function append_only();

    -- 跟进项状态机（2.6、Q14）：新建只能是 open；已处理、已忽略的只能重新打开；
    -- 处理人和时间由触发器按当前用户填写，不能伪造
    create function follow_up_items_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.status <> 'open' then
          raise exception 'new follow-up must be open' using errcode = 'check_violation';
        end if;
        new.first_triggered_at := now();
        new.last_triggered_at := now();
        new.created_at := now();
        return new;
      end if;
      if old.status in ('done', 'dismissed') then
        if new.status <> 'open' or new.note is distinct from old.note
          or new.basis <> old.basis or new.source_ref <> old.source_ref
          or new.severity <> old.severity or new.last_triggered_at <> old.last_triggered_at
        then
          raise exception 'follow-up is closed, reopen it first' using errcode = 'check_violation';
        end if;
        new.resolution := null;
        new.dismiss_reason := null;
        new.resolved_by := null;
        new.resolved_at := null;
        new.snooze_until := null;
        return new;
      end if;
      if new.status in ('done', 'dismissed') then
        new.resolved_by := app_user_id();
        new.resolved_at := now();
        new.snooze_until := null;
      elsif new.resolved_by is distinct from old.resolved_by
        or new.resolved_at is distinct from old.resolved_at
      then
        raise exception 'resolution is set by the system' using errcode = 'check_violation';
      end if;
      if new.status = 'snoozed' and new.snooze_until is distinct from old.snooze_until
        and new.snooze_until <= now()
      then
        raise exception 'snooze must end in the future' using errcode = 'check_violation';
      end if;
      if new.last_triggered_at is distinct from old.last_triggered_at then
        new.last_triggered_at := now();
      end if;
      return new;
    end
    $$;
    create trigger follow_up_items_guard before insert or update on follow_up_items
      for each row execute function follow_up_items_guard();

    -- 处理记录由触发器写入（不记备注和数值）；生成和重新触发的操作人为空（系统）
    create function follow_up_items_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_action text;
      v_actor uuid;
    begin
      if tg_op = 'INSERT' then
        v_action := 'created';
      elsif new.status is distinct from old.status then
        v_action := case
          when new.status = 'open' then 'reopened'
          else new.status
        end;
        v_actor := app_user_id();
      elsif new.last_triggered_at is distinct from old.last_triggered_at then
        v_action := 'retriggered';
      else
        return new;
      end if;
      insert into follow_up_events (operator_id, org_id, manager_id, client_id, item_id, actor_id, action)
        values (new.operator_id, new.org_id, new.manager_id, new.client_id, new.id, v_actor, v_action);
      return new;
    end
    $$;
    revoke all on function follow_up_items_audit() from public;
    create trigger follow_up_items_audit after insert or update on follow_up_items
      for each row execute function follow_up_items_audit();
    create trigger follow_up_items_no_delete before delete on follow_up_items
      for each row execute function append_only();

    -- 应用只能直接记录“请专家看看”（consulted），且以本人名义；其余记录由触发器写入
    create function follow_up_events_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.action <> 'consulted' or new.actor_id is distinct from app_user_id() then
        raise exception 'event must be recorded by the system' using errcode = 'check_violation';
      end if;
      new.created_at := clock_timestamp();
      return new;
    end
    $$;
    create trigger follow_up_events_guard before insert on follow_up_events
      for each row execute function follow_up_events_guard();
    create trigger follow_up_events_append_only before update or delete on follow_up_events
      for each row execute function append_only();
  `.execute(db);

  // 只能由系统写的表：应用角色只有 insert 和 select；预测只开放 superseded_at；
  // 跟进项只开放处理相关的列，客户、类型、去重键等不能改；都不授予 delete
  await sql`
    grant select, insert on twin_status_history, twin_forecasts, follow_up_items, follow_up_events
      to ${app};
    grant update (superseded_at) on twin_forecasts to ${app};
    grant update (severity, basis, source_ref, status, snooze_until, resolution, dismiss_reason,
                  note, last_triggered_at, resolved_by, resolved_at)
      on follow_up_items to ${app};
  `.execute(db);

  // 客户的机构或协会变了而健管师没变：新表的租户列也跟着同步（沿用 0009，加上本迁移的表）
  const tables = CLIENT_RECORD_TABLES.map(literal).join(', ');
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
