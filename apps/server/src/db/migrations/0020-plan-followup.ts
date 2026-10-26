import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M5 方案生成器 + 智能随访（规格 6.1、6.2、5.4 第 1 条）。
 *
 * 平台级数据（没有租户列）：
 * - 方案库三张表 plan_library_recipes、plan_library_exercises、plan_goal_templates：所有登录角色可读，
 *   但只有平台管理员能看到全部状态；其他角色只看已发布的条目（预览环境由后端设置
 *   hb.plan_library_preview = on 时另含待审定的）。只有平台管理员能写；修改由触发器记入 plan_library_events，
 *   内容改动时版本号加一；内容只能在草稿状态下修改（已发布的条目要先退回草稿，再送审发布）。
 * - 随访频次规则 visit_frequency_rules（每个风险分层一行）和 visit_frequency_config（单行：
 *   首次随访不晚于几天、版本号）：所有登录角色可读，只有平台管理员能改，修改记入 visit_frequency_rule_events，
 *   同一事务只加一次版本号（同 M4 的孪生规则）。
 *
 * 客户相关的新表（care_plans、visits、visit_materials、client_record_consents、visit_records、
 * visit_record_addenda、visit_events）：
 * - 都带 operator_id、org_id、manager_id、client_id，租户列由 client_record_tenant() 从客户行取，
 *   复合外键 (client_id, manager_id) → clients 跟着客户走（Q30），客户删除时级联删除。
 * - 只有服务这位客户的健管师有策略；机构管理员、运营商、平台管理员没有任何策略（Q28）。
 * - 随访素材只给上传的健管师看（2.9），客户转出时原文删除，新健管师也看不到旧素材。
 * - care_plans、visit_records 和随访计划写入的 visits 只经确认用的 SECURITY DEFINER 函数
 *   approve_care_plan、approve_visit_schedule、approve_visit_record 写入（红线 3）：应用角色没有 insert 权限，
 *   这三种产物的状态也不能由应用直接改为已审核，只能由函数在同一个事务里改并写入。
 * - 随访记录、补充说明、随访记录和同意记录只能追加。
 *
 * artifacts 加 structured、plan_options、visit_id、material_ids；task_messages 加 library_refs、
 * material_refs、plan_options；task_steps.kind 加 5 个。
 */

/** 迁移时的固定取值快照（迁移发布后不能改，有测试对照 packages/shared） */
export const PLAN_ENUM_SNAPSHOT = {
  allergens: ['peanut', 'tree_nut', 'dairy', 'egg', 'seafood', 'soy', 'gluten'],
  tags: [
    'low_oil',
    'low_salt',
    'high_fiber',
    'quality_protein',
    'mixed_grains',
    'vegetable_rich',
    'low_sugar',
    'quick',
    'vegetarian',
  ],
  meals: ['breakfast', 'lunch', 'dinner', 'snack'],
  sections: ['diet', 'exercise', 'routine', 'mind'],
  exerciseCategories: ['aerobic', 'strength', 'flexibility', 'balance', 'relaxation'],
  settings: ['home', 'outdoor', 'gym'],
  methods: ['phone', 'wechat', 'in_person', 'video'],
} as const;

/** 默认随访频次（第五节之二，候选，待医学顾问审定）；有测试对照 DEFAULT_VISIT_FREQUENCY_RULES */
export const VISIT_FREQUENCY_SNAPSHOT = {
  tiers: [
    ['high', 14, 'phone'],
    ['medium', 30, 'phone'],
    ['low', 90, 'wechat'],
    ['none', 30, 'phone'],
  ],
  firstVisitWithinDays: 3,
} as const;

/** 客户相关的表，客户换机构时同步租户列（沿用 0017 的列表，加上本迁移的表） */
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
];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const arr = (values: readonly string[]) =>
  sql.raw(`array[${values.map((v) => `'${v}'`).join(', ')}]::text[]`);

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  const S = PLAN_ENUM_SNAPSHOT;

  // ---------- 1. 方案库（2.4、第四节、6.2） ----------
  const libraryCommon = sql`
    source_note text not null check (char_length(source_note) between 1 and 300),
    status text not null default 'draft' check (status in ('draft', 'review', 'published', 'retired')),
    version int not null default 1 check (version >= 1),
    reviewed_by_label text check (char_length(reviewed_by_label) between 1 and 60),
    reviewed_on date,
    updated_by uuid references users (id),
    updated_at timestamptz not null default now(),
    -- 发布必须有审定人和日期（2.4）
    check (status <> 'published' or (reviewed_by_label is not null and reviewed_on is not null))
  `;
  await sql`
    create table plan_library_recipes (
      id uuid primary key default gen_random_uuid(),
      code text not null unique check (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
      name text not null check (char_length(name) between 1 and 60),
      meal_types text[] not null check (
        cardinality(meal_types) between 1 and 4 and meal_types <@ ${arr(S.meals)}
      ),
      ingredients jsonb not null check (
        jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) between 1 and 20
      ),
      steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 20),
      nutrition_per_serving jsonb check (jsonb_typeof(nutrition_per_serving) = 'object'),
      nutrition_basis text check (char_length(nutrition_basis) between 1 and 300),
      tags text[] not null default '{}' check (tags <@ ${arr(S.tags)}),
      -- 必须显式填写，可以为空数组（4.2）
      allergens text[] not null check (allergens <@ ${arr(S.allergens)}),
      ${libraryCommon},
      check (nutrition_per_serving is null or nutrition_basis is not null)
    );

    create table plan_library_exercises (
      id uuid primary key default gen_random_uuid(),
      code text not null unique check (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
      name text not null check (char_length(name) between 1 and 60),
      category text not null check (category in (${list(S.exerciseCategories)})),
      intensity text not null check (intensity in ('low', 'moderate')),
      setting text[] not null check (cardinality(setting) between 1 and 3 and setting <@ ${arr(S.settings)}),
      equipment text[] not null default '{}' check (cardinality(equipment) <= 10),
      steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 20),
      key_points jsonb not null check (
        jsonb_typeof(key_points) = 'array' and jsonb_array_length(key_points) between 1 and 20
      ),
      common_mistakes jsonb not null default '[]' check (
        jsonb_typeof(common_mistakes) = 'array' and jsonb_array_length(common_mistakes) <= 20
      ),
      -- 给健管师看的注意事项，必填（4.2），不进通俗版
      manager_cautions text not null check (char_length(btrim(manager_cautions)) between 1 and 500),
      met numeric(4, 1) check (met > 0 and met <= 20),
      ${libraryCommon}
    );

    create table plan_goal_templates (
      id uuid primary key default gen_random_uuid(),
      code text not null unique check (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
      section text not null check (section in (${list(S.sections)})),
      text text not null check (char_length(text) between 1 and 100),
      -- 参数的名称、类型、范围和默认值；形状由后端按 goalTemplateShapeError 校验
      params jsonb not null default '[]' check (jsonb_typeof(params) = 'array' and jsonb_array_length(params) <= 3),
      metric text check (metric in ('steps', 'sleep_hours')),
      metric_param text check (metric_param ~ '^[a-z][a-z0-9_]{0,31}$'),
      ${libraryCommon},
      check ((metric is null) = (metric_param is null))
    );

    create table plan_library_events (
      id bigint generated always as identity primary key,
      item_type text not null check (item_type in ('recipe', 'exercise', 'goal_template')),
      item_id uuid not null,
      actor_id uuid references users (id),
      action text not null check (action in ('created', 'updated', 'status_changed')),
      before jsonb,
      after jsonb,
      created_at timestamptz not null default clock_timestamp()
    );
    create index plan_library_events_item_idx on plan_library_events (item_type, item_id, created_at);
  `.execute(db);

  await sql`
    -- 预览环境（PLAN_LIBRARY_PREVIEW）由后端在事务里设置；只影响健管师和管理员能不能看到待审定的条目。
    -- 后端只能在配置 PLAN_LIBRARY_PREVIEW=true 时设置 hb.plan_library_preview = on（第 2、3 步实现时落实），
    -- 正式环境永远不设，否则待审定的条目会出现在方案库和 @ 里
    create function plan_library_preview() returns boolean language sql stable as $$
      select coalesce(current_setting('hb.plan_library_preview', true), '') = 'on'
    $$;

    -- 应用：新增只能是草稿、以本人名义；code 不能改；内容只能在草稿状态下改，改了版本号加一；
    -- 状态只能按顺序流转。种子导入（系统身份）不受限制
    create function plan_library_guard() returns trigger language plpgsql as $$
    declare
      content_changed boolean;
    begin
      if tg_op = 'INSERT' then
        if hb_is_system(tg_relid) then
          new.updated_at := now();
          return new;
        end if;
        if new.status <> 'draft' or new.version <> 1 then
          raise exception 'library item must be created as a draft' using errcode = 'check_violation';
        end if;
        if new.updated_by is distinct from app_user_id() then
          raise exception 'library item must be saved by the current user' using errcode = 'check_violation';
        end if;
        new.updated_at := now();
        return new;
      end if;
      if new.id <> old.id or new.code <> old.code then
        raise exception 'library item identity is immutable' using errcode = 'check_violation';
      end if;
      content_changed := (to_jsonb(new) - 'status' - 'version' - 'reviewed_by_label' - 'reviewed_on'
                          - 'updated_by' - 'updated_at')
                      <> (to_jsonb(old) - 'status' - 'version' - 'reviewed_by_label' - 'reviewed_on'
                          - 'updated_by' - 'updated_at');
      if not hb_is_system(tg_relid) then
        if new.updated_by is distinct from app_user_id() then
          raise exception 'library item must be saved by the current user' using errcode = 'check_violation';
        end if;
        if new.version <> old.version then
          raise exception 'version is set by the system' using errcode = 'check_violation';
        end if;
        if content_changed and (old.status <> 'draft' or new.status <> 'draft') then
          raise exception 'library item can only be edited as a draft' using errcode = 'check_violation';
        end if;
        if new.status <> old.status and not (
          (old.status = 'draft' and new.status = 'review')
          or (old.status = 'review' and new.status in ('draft', 'published'))
          or (old.status = 'published' and new.status in ('draft', 'retired'))
          or (old.status = 'retired' and new.status = 'draft')
        ) then
          raise exception 'invalid library status change' using errcode = 'check_violation';
        end if;
        -- 退回草稿时清掉审定信息，重新发布要再填
        if new.status = 'draft' and old.status <> 'draft' then
          new.reviewed_by_label := null;
          new.reviewed_on := null;
        end if;
      end if;
      if content_changed then
        new.version := old.version + 1;
      end if;
      new.updated_at := now();
      return new;
    end
    $$;

    -- 修改记录由触发器写入，应用不能伪造或漏记。库条目不是客户数据，可以记改前改后
    create function plan_library_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      insert into plan_library_events (item_type, item_id, actor_id, action, before, after)
        values (
          tg_argv[0],
          new.id,
          app_user_id(),
          case
            when tg_op = 'INSERT' then 'created'
            when new.version = old.version and new.status <> old.status then 'status_changed'
            else 'updated'
          end,
          case when tg_op = 'UPDATE' then to_jsonb(old) end,
          to_jsonb(new)
        );
      return new;
    end
    $$;
    revoke all on function plan_library_audit() from public;
  `.execute(db);

  for (const [table, type] of [
    ['plan_library_recipes', 'recipe'],
    ['plan_library_exercises', 'exercise'],
    ['plan_goal_templates', 'goal_template'],
  ] as const) {
    const t = sql.table(table);
    await sql`
      create trigger ${sql.id(`${table}_guard`)} before insert or update on ${t}
        for each row execute function plan_library_guard();
      create trigger ${sql.id(`${table}_audit`)} after insert or update on ${t}
        for each row execute function plan_library_audit(${sql.lit(type)});
      alter table ${t} enable row level security;
      create policy ${sql.id(`${table}_platform`)} on ${t} for all
        using (app_role() = 'platform_admin')
        with check (app_role() = 'platform_admin' and updated_by = app_user_id());
      -- 健管师、机构管理员、运营商只读已发布的条目（预览环境含待审定的）
      create policy ${sql.id(`${table}_select`)} on ${t} for select
        using (
          app_role() in ('operator_admin', 'org_admin', 'manager')
          and (status = 'published' or (status = 'review' and plan_library_preview()))
        );
    `.execute(db);
  }
  await sql`
    alter table plan_library_events enable row level security;
    create policy plan_library_events_select on plan_library_events for select
      using (app_role() = 'platform_admin');

    -- 不授予 delete：条目只停用不删除，已生效方案的快照里还记着它们
    grant select, insert on plan_library_recipes, plan_library_exercises, plan_goal_templates to ${app};
    grant update (name, meal_types, ingredients, steps, nutrition_per_serving, nutrition_basis, tags,
                  allergens, source_note, status, reviewed_by_label, reviewed_on, updated_by)
      on plan_library_recipes to ${app};
    grant update (name, category, intensity, setting, equipment, steps, key_points, common_mistakes,
                  manager_cautions, met, source_note, status, reviewed_by_label, reviewed_on, updated_by)
      on plan_library_exercises to ${app};
    grant update (section, text, params, metric, metric_param, source_note, status, reviewed_by_label,
                  reviewed_on, updated_by)
      on plan_goal_templates to ${app};
    grant select on plan_library_events to ${app};
    grant execute on function plan_library_preview() to ${app};
  `.execute(db);

  // ---------- 2. 随访频次规则（第五节之二、Q18） ----------
  await sql`
    create table visit_frequency_rules (
      risk_tier text primary key check (risk_tier in ('high', 'medium', 'low', 'none')),
      interval_days int not null check (interval_days between 7 and 180),
      default_method text not null check (default_method in (${list(S.methods)})),
      updated_by uuid references users (id),
      updated_at timestamptz not null default now()
    );

    -- 单行配置：首次随访不晚于几天（有 1、2 级未处理跟进项时）
    create table visit_frequency_config (
      id boolean primary key default true check (id),
      first_visit_within_days int not null check (first_visit_within_days between 1 and 14),
      updated_by uuid references users (id),
      updated_at timestamptz not null default now()
    );

    -- 规则整体的版本号（单行），每个修改规则的事务加一
    create table visit_frequency_version (
      id boolean primary key default true check (id),
      version int not null default 1,
      updated_at timestamptz not null default now(),
      bumped_xact xid8
    );
    insert into visit_frequency_version default values;

    create table visit_frequency_rule_events (
      id bigint generated always as identity primary key,
      actor_id uuid references users (id),
      before jsonb,
      after jsonb,
      rules_version int not null,
      created_at timestamptz not null default clock_timestamp()
    );
  `.execute(db);
  for (const [tier, interval, method] of VISIT_FREQUENCY_SNAPSHOT.tiers) {
    await sql`
      insert into visit_frequency_rules (risk_tier, interval_days, default_method)
      values (${tier}, ${interval}, ${method})
    `.execute(db);
  }
  await sql`
    insert into visit_frequency_config (first_visit_within_days)
      values (${VISIT_FREQUENCY_SNAPSHOT.firstVisitWithinDays})
  `.execute(db);

  await sql`
    -- 只能以本人名义修改；修改时间由触发器填写
    create function visit_frequency_guard() returns trigger language plpgsql as $$
    begin
      if not hb_is_system(tg_relid) and new.updated_by is distinct from app_user_id() then
        raise exception 'rules must be saved by the current user' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger visit_frequency_rules_guard before update on visit_frequency_rules
      for each row execute function visit_frequency_guard();
    create trigger visit_frequency_config_guard before update on visit_frequency_config
      for each row execute function visit_frequency_guard();

    -- 修改记录和版本号：同一个事务只加一次（改了几个分层算一次修改）。改规则不改已写入的随访
    create function visit_frequency_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v int;
      b jsonb := to_jsonb(old) - 'updated_by' - 'updated_at';
      a jsonb := to_jsonb(new) - 'updated_by' - 'updated_at';
    begin
      if a = b then
        return new;
      end if;
      update visit_frequency_version
        set version = version + 1, updated_at = now(), bumped_xact = pg_current_xact_id()
        where bumped_xact is distinct from pg_current_xact_id();
      select version into v from visit_frequency_version;
      insert into visit_frequency_rule_events (actor_id, before, after, rules_version)
        values (app_user_id(), b, a, v);
      return new;
    end
    $$;
    revoke all on function visit_frequency_audit() from public;
    create trigger visit_frequency_rules_audit after update on visit_frequency_rules
      for each row execute function visit_frequency_audit();
    create trigger visit_frequency_config_audit after update on visit_frequency_config
      for each row execute function visit_frequency_audit();

    alter table visit_frequency_rules enable row level security;
    alter table visit_frequency_config enable row level security;
    alter table visit_frequency_rule_events enable row level security;
    alter table visit_frequency_version enable row level security;
    create policy visit_frequency_version_select on visit_frequency_version for select
      using (app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager'));
    create policy visit_frequency_rules_select on visit_frequency_rules for select
      using (app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager'));
    create policy visit_frequency_rules_update on visit_frequency_rules for update
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());
    create policy visit_frequency_config_select on visit_frequency_config for select
      using (app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager'));
    create policy visit_frequency_config_update on visit_frequency_config for update
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());
    create policy visit_frequency_rule_events_select on visit_frequency_rule_events for select
      using (app_role() = 'platform_admin');

    -- 分层固定四行，不能新增和删除
    grant select on visit_frequency_rules, visit_frequency_config, visit_frequency_version,
      visit_frequency_rule_events to ${app};
    grant update (interval_days, default_method, updated_by) on visit_frequency_rules to ${app};
    grant update (first_visit_within_days, updated_by) on visit_frequency_config to ${app};
  `.execute(db);

  // ---------- 3. artifacts、task_messages、task_steps 扩展（6.2） ----------
  await sql`
    alter table artifacts
      add column structured jsonb check (structured is null or jsonb_typeof(structured) = 'object'),
      add column plan_options jsonb check (
        plan_options is null or (
          jsonb_typeof(plan_options) = 'object'
          and jsonb_typeof(plan_options -> 'sections') = 'array'
          and jsonb_array_length(plan_options -> 'sections') between 1 and 4
          and plan_options -> 'cycleWeeks' in ('4'::jsonb, '8'::jsonb, '12'::jsonb)
        )
      ),
      add column visit_id uuid,
      add column material_ids uuid[] check (material_ids is null or cardinality(material_ids) between 1 and 3),
      -- 方案草稿必须带方案选项；其他产物没有
      add constraint artifacts_plan_options check ((kind = 'care_plan') = (plan_options is not null)),
      add constraint artifacts_material_ids check (material_ids is null or kind = 'visit_record');

    alter table task_messages
      add column library_refs jsonb not null default '[]' check (
        jsonb_typeof(library_refs) = 'array' and jsonb_array_length(library_refs) <= 3
      ),
      add column material_refs uuid[] not null default '{}' check (cardinality(material_refs) <= 3),
      add column plan_options jsonb check (plan_options is null or jsonb_typeof(plan_options) = 'object');

    alter table task_steps
      drop constraint task_steps_kind_check,
      add constraint task_steps_kind_check check (
        kind in (
          'read_client', 'read_report', 'compare_reports', 'detect_critical', 'run_skill', 'answer',
          'route_experts', 'consult_experts', 'consult_expert', 'synthesize_experts',
          'read_twin', 'compute_forecast',
          'read_care_plan', 'select_library_items', 'schedule_visits', 'read_visit_materials',
          'read_visit_records'
        )
      );
  `.execute(db);

  // ---------- 4. 客户相关的新表（6.2） ----------
  await sql`
    create table care_plans (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      -- 确认的那一版产物；客户转出时置空（产物按 M1 Q11 作废，快照保留，Q30）
      artifact_id uuid,
      lineage_id uuid not null,
      sections text[] not null check (
        cardinality(sections) between 1 and 4 and sections <@ ${arr(S.sections)}
      ),
      -- 专业版和通俗版全文、行为目标及参数、引用的库条目和版本。含健康内容，不进日志
      snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
      cycle_weeks smallint not null check (cycle_weeks in (4, 8, 12)),
      start_date date not null,
      review_date date not null,
      status text not null check (status in ('active', 'ended', 'superseded')),
      end_reason text check (end_reason in ('cycle_completed', 'client_paused', 'needs_medical_review', 'other')),
      approved_by uuid not null references users (id),
      approved_at timestamptz not null default now(),
      ended_by uuid references users (id),
      ended_at timestamptz,
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (artifact_id, client_id) references artifacts (id, client_id),
      constraint care_plans_review_date check (review_date = start_date + cycle_weeks * 7),
      constraint care_plans_state check (
        (status = 'active' and end_reason is null and ended_by is null and ended_at is null)
        or (status = 'ended' and end_reason is not null and ended_by is not null and ended_at is not null)
        or (status = 'superseded' and end_reason is null and ended_at is not null)
      )
    );
    -- 每位客户最多一份生效方案
    create unique index care_plans_active on care_plans (client_id) where status = 'active';
    create index care_plans_client_idx on care_plans (client_id, approved_at desc);
    create index care_plans_manager_idx on care_plans (manager_id);
    create index care_plans_artifact_idx on care_plans (artifact_id);

    create table visits (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      due_date date not null,
      method text not null check (method in (${list(S.methods)})),
      purpose text not null check (purpose in ('routine', 'plan_review', 'follow_up', 'adhoc')),
      -- 重点（≤ 200 字）和备注（≤ 500 字）只存数据库，不进日志和随访记录（visit_events）
      focus text check (char_length(focus) <= 200),
      origin text not null check (origin in ('schedule', 'plan_review', 'manual')),
      source_artifact_id uuid,
      care_plan_id uuid,
      follow_up_item_id uuid,
      status text not null default 'planned' check (
        status in ('planned', 'done', 'missed', 'cancelled', 'superseded', 'pending_plan')
      ),
      cancel_reason text check (cancel_reason in ('client_paused', 'contacted_elsewhere', 'duplicate', 'other')),
      note text check (char_length(note) between 1 and 500),
      record_id uuid,
      rescheduled_from date,
      done_at timestamptz,
      created_by uuid references users (id),
      created_at timestamptz not null default now(),
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      -- 复合外键保证方案、跟进项、来源产物和记录都属于同一位客户
      foreign key (care_plan_id, client_id) references care_plans (id, client_id),
      foreign key (follow_up_item_id, client_id) references follow_up_items (id, client_id)
        on delete set null (follow_up_item_id),
      foreign key (source_artifact_id, client_id) references artifacts (id, client_id),
      -- 完成必须关联记录或写备注（Q26）；取消必须有原因
      constraint visits_done check (
        status <> 'done' or (done_at is not null and (record_id is not null or note is not null))
      ),
      constraint visits_cancel check ((status = 'cancelled') = (cancel_reason is not null)),
      constraint visits_origin check (
        (origin = 'plan_review' and purpose = 'plan_review')
        or (origin = 'manual' and purpose in ('routine', 'follow_up', 'adhoc'))
        or (origin = 'schedule' and purpose in ('routine', 'plan_review', 'follow_up'))
      ),
      constraint visits_pending_plan check (
        status <> 'pending_plan' or (origin = 'schedule' and purpose = 'plan_review' and care_plan_id is null)
      )
    );
    create index visits_manager_due_idx on visits (manager_id, status, due_date);
    create index visits_client_idx on visits (client_id, due_date);
    create index visits_care_plan_idx on visits (care_plan_id);
    create index visits_source_artifact_idx on visits (source_artifact_id);

    create table client_record_consents (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      kind text not null check (kind in ('visit_material')),
      confirmed_by uuid not null references users (id),
      confirmed_at timestamptz not null default now(),
      unique (client_id, kind, confirmed_by),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );

    create table visit_materials (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      visit_id uuid,
      kind text not null check (kind in ('paste', 'txt')),
      -- 原文由后端加密后存入；删除原文（到期、客户转出）后为空
      text_encrypted bytea,
      char_count int not null check (char_count between 1 and 20000),
      uploaded_by uuid not null references users (id),
      consumed_artifact_id uuid,
      purge_after timestamptz not null,
      purged_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (visit_id, client_id) references visits (id, client_id) on delete set null (visit_id),
      foreign key (consumed_artifact_id, client_id) references artifacts (id, client_id),
      constraint visit_materials_purged check ((text_encrypted is null) = (purged_at is not null))
    );
    create index visit_materials_client_idx on visit_materials (client_id, created_at desc);
    create index visit_materials_purge_idx on visit_materials (purge_after) where purged_at is null;
    create index visit_materials_uploader_idx on visit_materials (uploaded_by, created_at);

    create table visit_records (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      visit_id uuid,
      artifact_id uuid,
      visit_date date not null,
      method text not null check (method in (${list(S.methods)})),
      -- 结构化记录全文，含健康内容，不进日志
      snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
      approved_by uuid not null references users (id),
      approved_at timestamptz not null default now(),
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (visit_id, client_id) references visits (id, client_id) on delete set null (visit_id),
      foreign key (artifact_id, client_id) references artifacts (id, client_id)
    );
    create index visit_records_client_idx on visit_records (client_id, visit_date desc);
    create index visit_records_manager_idx on visit_records (manager_id);
    create unique index visit_records_artifact on visit_records (artifact_id);

    alter table visits
      add foreign key (record_id, client_id) references visit_records (id, client_id);

    create table visit_record_addenda (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      record_id uuid not null,
      text text not null check (char_length(btrim(text)) between 1 and 1000),
      created_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (record_id, client_id) references visit_records (id, client_id) on delete cascade
    );
    create index visit_record_addenda_record_idx on visit_record_addenda (record_id, created_at);

    -- 只记谁在什么时候做了什么，不记备注和重点原文
    create table visit_events (
      id bigint generated always as identity primary key,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      visit_id uuid not null,
      actor_id uuid references users (id),
      action text not null check (
        action in ('created', 'rescheduled', 'done', 'missed', 'cancelled', 'superseded', 'plan_activated')
      ),
      created_at timestamptz not null default clock_timestamp(),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (visit_id, client_id) references visits (id, client_id) on delete cascade
    );
    create index visit_events_visit_idx on visit_events (visit_id, created_at);
    create index visit_events_client_idx on visit_events (client_id, created_at);

    alter table artifacts
      add foreign key (visit_id, client_id) references visits (id, client_id) on delete set null (visit_id);
    create index artifacts_visit_idx on artifacts (visit_id);
  `.execute(db);

  // 行级安全：只有服务这位客户的健管师（Q28：机构管理员、运营商、平台都没有策略）
  const managerUsing = sql`app_role() = 'manager' and manager_id = app_user_id()`;
  const managerCheck = sql`
    app_role() = 'manager' and manager_id = app_user_id()
    and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
  `;
  for (const table of [
    'care_plans',
    'visits',
    'client_record_consents',
    'visit_materials',
    'visit_records',
    'visit_record_addenda',
    'visit_events',
  ]) {
    const t = sql.table(table);
    await sql`
      alter table ${t} enable row level security;
      create trigger ${sql.id(`${table}_tenant`)} before insert or update on ${t}
        for each row execute function client_record_tenant();
    `.execute(db);
  }
  await sql`
    -- 方案：读；只能把生效方案结束（触发器只放行这几列），没有 insert 策略（只经 approve_care_plan）
    create policy care_plans_manager_select on care_plans for select using (${managerUsing});
    create policy care_plans_manager_update on care_plans for update
      using (${managerUsing}) with check (${managerCheck});

    -- 随访：读、手动加一次、处理；随访计划和方案复评只经确认函数写入
    create policy visits_manager_select on visits for select using (${managerUsing});
    create policy visits_manager_insert on visits for insert with check (${managerCheck});
    create policy visits_manager_update on visits for update
      using (${managerUsing}) with check (${managerCheck});

    create policy client_record_consents_manager_select on client_record_consents for select
      using (${managerUsing});
    create policy client_record_consents_manager_insert on client_record_consents for insert
      with check (${managerCheck});

    -- 素材只给上传的健管师看（2.9）：客户转出后新健管师也看不到旧素材
    create policy visit_materials_uploader on visit_materials for all
      using (${managerUsing} and uploaded_by = app_user_id())
      with check (${managerCheck} and uploaded_by = app_user_id());

    create policy visit_records_manager_select on visit_records for select using (${managerUsing});

    create policy visit_record_addenda_manager_select on visit_record_addenda for select
      using (${managerUsing});
    create policy visit_record_addenda_manager_insert on visit_record_addenda for insert
      with check (${managerCheck});

    create policy visit_events_manager_select on visit_events for select using (${managerUsing});
  `.execute(db);

  // ---------- 5. 触发器 ----------
  await sql`
    -- 健管师的“今天”（按账号时区，没有设置时按北京时间）。只在下面的函数里用
    create function hb_user_today() returns date
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select (now() at time zone coalesce(
        (select u.timezone from users u where u.id = app_user_id()), 'Asia/Shanghai'))::date
    $$;
    revoke all on function hb_user_today() from public;

    -- 方案：应用只能把生效方案结束，必须有原因；结束人和时间由触发器填写
    create function care_plans_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if old.status <> 'active' or new.status <> 'ended' or new.end_reason is null
        or (to_jsonb(new) - 'status' - 'end_reason' - 'ended_by' - 'ended_at')
           <> (to_jsonb(old) - 'status' - 'end_reason' - 'ended_by' - 'ended_at')
      then
        raise exception 'only an active plan can be ended' using errcode = 'check_violation';
      end if;
      new.ended_by := app_user_id();
      new.ended_at := now();
      return new;
    end
    $$;
    create trigger care_plans_guard before update on care_plans
      for each row execute function care_plans_guard();
    create trigger care_plans_no_delete before delete on care_plans
      for each row execute function append_only();

    -- 随访：应用只能手动加（origin = manual、待随访、以本人名义），只能处理还没处理的随访
    create function visits_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.origin <> 'manual' or new.status <> 'planned' or new.created_by is distinct from app_user_id()
          or new.source_artifact_id is not null or new.care_plan_id is not null
          or new.record_id is not null or new.done_at is not null or new.rescheduled_from is not null
          or new.cancel_reason is not null or new.note is not null
        then
          raise exception 'only manual planned visits can be added' using errcode = 'check_violation';
        end if;
        -- 前后各留一天，容纳健管师时区和账号时区的差别；精确的日期范围由后端按时区校验
        if new.due_date < current_date - 1 or new.due_date > (current_date + interval '6 months')::date + 1 then
          raise exception 'visit date out of range' using errcode = 'check_violation';
        end if;
        new.created_at := now();
        return new;
      end if;

      if old.status not in ('planned', 'missed', 'pending_plan') then
        raise exception 'visit is already closed' using errcode = 'check_violation';
      end if;
      if (to_jsonb(new) - 'due_date' - 'method' - 'focus' - 'status' - 'cancel_reason' - 'note'
            - 'record_id' - 'rescheduled_from' - 'done_at')
         <> (to_jsonb(old) - 'due_date' - 'method' - 'focus' - 'status' - 'cancel_reason' - 'note'
            - 'record_id' - 'rescheduled_from' - 'done_at')
      then
        raise exception 'visit identity is immutable' using errcode = 'check_violation';
      end if;
      -- 等方案生效的复评只能取消，日期由方案生效时确定
      if old.status = 'pending_plan' and new.status not in ('pending_plan', 'cancelled') then
        raise exception 'visit waits for its plan' using errcode = 'check_violation';
      end if;
      if new.status in ('superseded', 'pending_plan') and new.status <> old.status then
        raise exception 'visit status is set by the system' using errcode = 'check_violation';
      end if;
      if new.record_id is distinct from old.record_id and new.status <> 'done' then
        raise exception 'record only with done' using errcode = 'check_violation';
      end if;
      if new.status = 'done' then
        new.done_at := now();
      elsif new.done_at is not null then
        raise exception 'done time is set by the system' using errcode = 'check_violation';
      end if;
      if new.due_date <> old.due_date then
        if new.status not in ('planned', 'missed') then
          raise exception 'invalid reschedule' using errcode = 'check_violation';
        end if;
        if new.due_date < current_date - 1 or new.due_date > (current_date + interval '6 months')::date + 1 then
          raise exception 'visit date out of range' using errcode = 'check_violation';
        end if;
        new.rescheduled_from := old.due_date;
      elsif new.rescheduled_from is distinct from old.rescheduled_from then
        raise exception 'rescheduled_from is set by the system' using errcode = 'check_violation';
      end if;
      -- 未联系上必须顺延到别的日期
      if new.status = 'missed' and new.due_date = old.due_date then
        raise exception 'missed visit needs a new date' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger visits_guard before insert or update on visits
      for each row execute function visits_guard();
    create trigger visits_no_delete before delete on visits
      for each row execute function append_only();

    -- 随访的处理记录由触发器写入（不记重点和备注）
    create function visits_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_action text;
    begin
      if tg_op = 'INSERT' then
        v_action := 'created';
      elsif new.status is distinct from old.status then
        v_action := case
          when old.status = 'pending_plan' and new.status = 'planned' then 'plan_activated'
          when new.status = 'planned' then 'rescheduled'
          else new.status
        end;
      elsif new.due_date is distinct from old.due_date then
        v_action := 'rescheduled';
      else
        return new;
      end if;
      insert into visit_events (operator_id, org_id, manager_id, client_id, visit_id, actor_id, action)
        values (new.operator_id, new.org_id, new.manager_id, new.client_id, new.id, app_user_id(), v_action);
      return new;
    end
    $$;
    revoke all on function visits_audit() from public;
    create trigger visits_audit after insert or update on visits
      for each row execute function visits_audit();

    create trigger visit_events_append_only before update or delete on visit_events
      for each row execute function append_only();
    create function visit_events_guard() returns trigger language plpgsql as $$
    begin
      if not hb_is_system(tg_relid) then
        raise exception 'event must be recorded by the system' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger visit_events_guard before insert on visit_events
      for each row execute function visit_events_guard();

    -- “已告知客户”：以本人名义、当前时间，只能追加
    create function client_record_consents_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.confirmed_by is distinct from app_user_id() then
        raise exception 'consent must be confirmed by the current user' using errcode = 'check_violation';
      end if;
      new.confirmed_at := now();
      return new;
    end
    $$;
    create trigger client_record_consents_guard before insert on client_record_consents
      for each row execute function client_record_consents_guard();
    create trigger client_record_consents_append_only before update or delete on client_record_consents
      for each row execute function append_only();

    -- 素材：以本人名义上传；本人必须已勾选“已告知客户”（Q24）；原文 30 天后删除（Q23）。
    -- 以调用者身份查同意记录（受行级安全约束）
    create function visit_materials_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return coalesce(new, old);
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      if new.uploaded_by is distinct from app_user_id() or new.text_encrypted is null
        or new.consumed_artifact_id is not null or new.purged_at is not null
      then
        raise exception 'material must be uploaded by the current user' using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from client_record_consents c
        where c.client_id = new.client_id and c.kind = 'visit_material' and c.confirmed_by = app_user_id()
      ) then
        raise exception 'client has not been informed' using errcode = 'check_violation';
      end if;
      new.created_at := now();
      new.purge_after := now() + interval '30 days';
      return new;
    end
    $$;
    create trigger visit_materials_guard before insert or delete on visit_materials
      for each row execute function visit_materials_guard();

    -- 随访记录只能追加（系统级联和客户转出时置空来源产物除外）
    create trigger visit_records_append_only before update or delete on visit_records
      for each row execute function append_only();
    create function visit_records_guard() returns trigger language plpgsql as $$
    begin
      if not hb_is_system(tg_relid) then
        raise exception 'records are written by approve_visit_record' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger visit_records_guard before insert on visit_records
      for each row execute function visit_records_guard();

    create function visit_record_addenda_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.created_by is distinct from app_user_id() then
        raise exception 'addendum must be written by the current user' using errcode = 'check_violation';
      end if;
      new.created_at := now();
      return new;
    end
    $$;
    create trigger visit_record_addenda_guard before insert on visit_record_addenda
      for each row execute function visit_record_addenda_guard();
    create trigger visit_record_addenda_append_only before update or delete on visit_record_addenda
      for each row execute function append_only();
  `.execute(db);

  // 产物：结构化内容只能在草稿时改；方案选项、关联的随访和素材生成后不能改（系统置空除外）；
  // 素材必须是产物客户的、本人上传的；三种会写数据的产物只能经确认函数审核（5.4 第 1 条）
  await sql`
    create or replace function artifacts_guard() returns trigger language plpgsql as $$
    declare
      is_app boolean := not hb_is_system(tg_relid);
    begin
      if tg_op = 'INSERT' then
        if new.status <> 'draft' then
          raise exception 'artifact must be inserted as draft' using errcode = 'check_violation';
        end if;
        if is_app and task_detached(new.task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        -- 外键在 client_id 为空时不检查，这里补上：产物的客户必须和任务当前的客户一致
        if new.client_id is distinct from (select t.client_id from tasks t where t.id = new.task_id) then
          raise exception 'artifact client must match its task' using errcode = 'check_violation';
        end if;
        if new.parent_id is not null and new.lineage_id is distinct from
          (select a.lineage_id from artifacts a where a.id = new.parent_id)
        then
          raise exception 'artifact version must stay in its lineage' using errcode = 'check_violation';
        end if;
        if (new.visit_id is not null or new.material_ids is not null) and new.client_id is null then
          raise exception 'artifact visit needs a client' using errcode = 'check_violation';
        end if;
        -- 以调用者身份查素材（只有上传的健管师看得到）
        if new.material_ids is not null and is_app and (
          select count(*) from visit_materials m
          where m.id = any (new.material_ids) and m.client_id = new.client_id
        ) <> cardinality(new.material_ids) then
          raise exception 'materials must belong to the artifact client' using errcode = 'check_violation';
        end if;
        return new;
      end if;

      if old.status <> 'draft' then
        -- 非草稿行只允许系统把客户、依据的报告、关联的随访和素材置空（客户转出或删除、报告删除）
        -- 和跟随健管师调机构
        if is_app
          or (to_jsonb(new) - 'client_id' - 'org_id' - 'updated_at' - 'source_report_id' - 'visit_id' - 'material_ids')
             <> (to_jsonb(old) - 'client_id' - 'org_id' - 'updated_at' - 'source_report_id' - 'visit_id' - 'material_ids')
          or (new.client_id is distinct from old.client_id and new.client_id is not null)
          or (new.source_report_id is distinct from old.source_report_id
              and new.source_report_id is not null)
          or (new.visit_id is distinct from old.visit_id and new.visit_id is not null)
          or (new.material_ids is distinct from old.material_ids and new.material_ids is not null)
        then
          raise exception 'artifact is no longer a draft' using errcode = 'check_violation';
        end if;
        return new;
      end if;

      if new.id <> old.id or new.task_id <> old.task_id or new.manager_id <> old.manager_id
        or new.operator_id <> old.operator_id or new.skill_id <> old.skill_id
        or new.kind <> old.kind or new.lineage_id <> old.lineage_id
        or new.version <> old.version or new.parent_id is distinct from old.parent_id
        or new.created_at <> old.created_at
        or new.critical_flags <> old.critical_flags
        or new.plan_options is distinct from old.plan_options
      then
        raise exception 'artifact identity is immutable' using errcode = 'check_violation';
      end if;
      if (new.visit_id is distinct from old.visit_id and (is_app or new.visit_id is not null))
        or (new.material_ids is distinct from old.material_ids and (is_app or new.material_ids is not null))
      then
        raise exception 'artifact visit is immutable' using errcode = 'check_violation';
      end if;
      if is_app then
        if task_detached(old.task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        if new.client_id is distinct from old.client_id then
          raise exception 'artifact client is immutable' using errcode = 'check_violation';
        end if;
        if new.status = 'voided' then
          raise exception 'only the system can void a draft' using errcode = 'check_violation';
        end if;
        -- 方案、随访计划、随访记录确认时要写 care_plans、visits、visit_records，只能经确认函数
        if new.status = 'approved' and old.kind in ('care_plan', 'visit_schedule', 'visit_record') then
          raise exception 'approve this artifact through its approve function'
            using errcode = 'insufficient_privilege';
        end if;
      end if;
      if new.status <> 'draft'
        and (new.content <> old.content or new.structured is distinct from old.structured)
      then
        raise exception 'content and status cannot change together' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    -- 消息：@ 的素材必须是任务客户的、本人上传的；@ 的库条目必须看得到（已发布）。
    -- 以调用者身份查（受行级安全约束），看不到的按不存在处理
    create function task_messages_m5_refs_guard() returns trigger language plpgsql as $$
    declare
      v_client uuid;
      ref jsonb;
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      -- 只在写入引用时检查：引用的素材以后被删除或清理，不影响这条消息的其他更新（如流式写入内容、状态）
      if tg_op = 'UPDATE' and new.material_refs = old.material_refs
        and new.library_refs = old.library_refs and new.task_id = old.task_id
      then
        return new;
      end if;
      if cardinality(new.material_refs) > 0 then
        select t.client_id into v_client from tasks t where t.id = new.task_id;
        if v_client is null or (
          select count(*) from visit_materials m
          where m.id = any (new.material_refs) and m.client_id = v_client
        ) <> cardinality(new.material_refs) then
          raise exception 'message can only reference materials of the task client'
            using errcode = 'check_violation';
        end if;
      end if;
      for ref in select * from jsonb_array_elements(new.library_refs)
      loop
        if jsonb_typeof(ref) <> 'object' or (ref ->> 'id') !~ '^[0-9a-f-]{36}$' or not (
          (ref ->> 'type' = 'recipe'
            and exists (select 1 from plan_library_recipes r where r.id = (ref ->> 'id')::uuid))
          or (ref ->> 'type' = 'exercise'
            and exists (select 1 from plan_library_exercises e where e.id = (ref ->> 'id')::uuid))
        ) then
          raise exception 'message can only reference published library items'
            using errcode = 'check_violation';
        end if;
      end loop;
      return new;
    end
    $$;
    create trigger task_messages_m5_refs_guard before insert or update on task_messages
      for each row execute function task_messages_m5_refs_guard();
  `.execute(db);

  // ---------- 6. 确认函数（5.4 第 1 条、6.1） ----------
  // 以所有者身份执行（要写应用角色没有 insert 权限的表），所以在函数里显式校验：
  // 当前是健管师、产物是本人的、kind 正确、是这条产物链的最新草稿、任务没有断开、关联了客户。
  // 加锁顺序和客户转出一致：先锁客户（no key update，同一客户的确认串行、挡住转出），再锁产物。
  await sql`
    create function m5_lock_draft(p_artifact_id uuid, p_kind text) returns artifacts
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_client uuid;
      a artifacts;
    begin
      if app_role() is distinct from 'manager' or app_user_id() is null then
        raise exception 'only managers can approve' using errcode = 'insufficient_privilege';
      end if;
      select x.client_id into v_client from artifacts x
        where x.id = p_artifact_id and x.manager_id = app_user_id();
      if v_client is null then
        raise exception 'artifact not found' using errcode = 'no_data_found';
      end if;
      -- 排他的行锁（不挡外键检查）：同一位客户的确认互相排队，后一个看到前一个写入的方案和随访，
      -- 不会出现两份随访计划都是待随访、或生效方案旁边留着待方案生效的复评；也挡住客户转出
      perform 1 from clients c where c.id = v_client and c.manager_id = app_user_id()
        for no key update;
      if not found then
        raise exception 'artifact not found' using errcode = 'no_data_found';
      end if;
      select * into a from artifacts x
        where x.id = p_artifact_id and x.manager_id = app_user_id() and x.client_id = v_client
        for update;
      if not found then
        raise exception 'artifact not found' using errcode = 'no_data_found';
      end if;
      if a.kind <> p_kind then
        raise exception 'wrong artifact kind' using errcode = 'check_violation';
      end if;
      if a.status <> 'draft' or exists (
        select 1 from artifacts n where n.lineage_id = a.lineage_id and n.version > a.version
      ) then
        raise exception 'artifact is not the latest draft' using errcode = 'check_violation';
      end if;
      if task_detached(a.task_id) then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      if a.structured is null then
        raise exception 'artifact has no structured content' using errcode = 'check_violation';
      end if;
      update artifacts set status = 'approved' where id = a.id;
      return a;
    end
    $$;
    revoke all on function m5_lock_draft(uuid, text) from public;

    -- 客户当前分层对应的默认随访方式（没有分层按 none）
    create function m5_default_visit_method(p_client_id uuid) returns text
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select r.default_method from visit_frequency_rules r
      where r.risk_tier = coalesce(
        (select t.tier from client_risk_tiers t where t.client_id = p_client_id
          order by t.set_at desc, t.id desc limit 1),
        'none')
    $$;
    revoke all on function m5_default_visit_method(uuid) from public;

    create function m5_weekday_or_monday(p_date date) returns date language sql immutable as $$
      select case extract(isodow from p_date)
        when 6 then p_date + 2 when 7 then p_date + 1 else p_date end
    $$;

    -- 方案确认（2.3）：产物改为已审核，写入 care_plans 生效；旧的生效方案标为已被替代，
    -- 它还没处理的复评随访也标为已被替代；排一次“方案复评”随访（周期结束那天，周末顺延到周一）。
    -- 同一客户有等待方案生效的复评（随访计划先确认，2.10）时，改为这一次，不重复排。
    -- 引用的库条目必须仍是已发布状态，快照里记下当时的版本。
    create function approve_care_plan(p_artifact_id uuid) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a artifacts;
      v_today date := hb_user_today();
      v_weeks int;
      v_sections text[];
      v_refs jsonb;
      v_versions jsonb;
      v_plan uuid;
      v_review date;
      v_pending uuid;
    begin
      a := m5_lock_draft(p_artifact_id, 'care_plan');
      v_weeks := (a.plan_options ->> 'cycleWeeks')::int;
      select array_agg(s) into v_sections from jsonb_array_elements_text(a.plan_options -> 'sections') s;

      -- 引用的库条目：食谱、运动条目、目标模板
      select coalesce(jsonb_agg(distinct x), '[]') into v_refs from (
        select jsonb_build_object('type', 'recipe', 'id', r ->> 'recipeId') as x
          from jsonb_array_elements(coalesce(a.structured -> 'recipes', '[]')) r
        union all
        select jsonb_build_object('type', 'exercise', 'id', e ->> 'exerciseId')
          from jsonb_array_elements(coalesce(a.structured -> 'exercises', '[]')) e
        union all
        select jsonb_build_object('type', 'goal_template', 'id', g ->> 'templateId')
          from jsonb_array_elements(coalesce(a.structured -> 'sections', '[]')) s,
               jsonb_array_elements(coalesce(s -> 'goals', '[]')) g
      ) refs;
      if exists (
        select 1 from jsonb_array_elements(v_refs) x
        where (x ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) then
        raise exception 'library item unavailable' using errcode = 'check_violation';
      end if;
      select coalesce(jsonb_agg(jsonb_build_object('type', x ->> 'type', 'id', x ->> 'id',
               'version', v.version)), '[]')
        into v_versions
        from jsonb_array_elements(v_refs) x
        join lateral (
          select r.version from plan_library_recipes r
            where x ->> 'type' = 'recipe' and r.id = (x ->> 'id')::uuid and r.status = 'published'
          union all
          select e.version from plan_library_exercises e
            where x ->> 'type' = 'exercise' and e.id = (x ->> 'id')::uuid and e.status = 'published'
          union all
          select g.version from plan_goal_templates g
            where x ->> 'type' = 'goal_template' and g.id = (x ->> 'id')::uuid and g.status = 'published'
        ) v on true;
      if jsonb_array_length(v_versions) <> jsonb_array_length(v_refs) then
        raise exception 'library item unavailable' using errcode = 'check_violation';
      end if;

      -- 旧方案被替代，它还没处理的复评随访也被替代
      with old as (
        update care_plans set status = 'superseded', ended_at = now(), ended_by = app_user_id()
          where client_id = a.client_id and status = 'active'
          returning id
      )
      update visits set status = 'superseded'
        where care_plan_id in (select id from old) and status in ('planned', 'missed');

      v_review := v_today + v_weeks * 7;
      insert into care_plans (operator_id, org_id, manager_id, client_id, artifact_id, lineage_id, sections,
                              snapshot, cycle_weeks, start_date, review_date, status, approved_by)
        values (a.operator_id, a.org_id, a.manager_id, a.client_id, a.id, a.lineage_id, v_sections,
                jsonb_build_object('structured', a.structured, 'content', a.content,
                                   'libraryVersions', v_versions),
                v_weeks, v_today, v_review, 'active', app_user_id())
        returning id into v_plan;

      select v.id into v_pending from visits v
        where v.client_id = a.client_id and v.status = 'pending_plan'
        order by v.created_at desc, v.id desc limit 1;
      if v_pending is not null then
        update visits set status = 'superseded'
          where client_id = a.client_id and status = 'pending_plan' and id <> v_pending;
        update visits set status = 'planned', care_plan_id = v_plan,
            due_date = m5_weekday_or_monday(v_review)
          where id = v_pending;
      else
        insert into visits (operator_id, org_id, manager_id, client_id, due_date, method, purpose,
                            origin, care_plan_id, source_artifact_id, status, created_by)
          values (a.operator_id, a.org_id, a.manager_id, a.client_id, m5_weekday_or_monday(v_review),
                  m5_default_visit_method(a.client_id), 'plan_review', 'plan_review', v_plan, a.id,
                  'planned', app_user_id());
      end if;
      return v_plan;
    end
    $$;
    revoke all on function approve_care_plan(uuid) from public;

    -- 随访计划确认（2.7）：日期不早于今天、不超过 6 个月后（前后各留一天容纳时区差别）、不重复；
    -- 这位客户以前由随访计划排出、还没到期的随访标为已被替代（手动加的和方案复评不受影响）。
    -- 计划里的“方案复评”：和生效方案的复评相隔不到 7 天时就是那一次（只补上重点）；
    -- 否则是给还没生效的新方案排的，标为“待方案生效”，方案确认时再定日期（2.10）。
    create function approve_visit_schedule(p_artifact_id uuid) returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a artifacts;
      v_today date := hb_user_today();
      r record;
      v_count int := 0;
      v_plan care_plans;
      v_review_visit uuid;
    begin
      a := m5_lock_draft(p_artifact_id, 'visit_schedule');
      if jsonb_typeof(a.structured -> 'rows') is distinct from 'array'
        or jsonb_array_length(a.structured -> 'rows') not between 1 and 30
      then
        raise exception 'schedule mismatch' using errcode = 'check_violation';
      end if;
      if exists (
        select 1 from jsonb_array_elements(a.structured -> 'rows') x
        where jsonb_typeof(x) <> 'object'
          or coalesce(x ->> 'dueDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or (x ->> 'method') is null or (x ->> 'method') not in (${list(S.methods)})
          or (x ->> 'purpose') is null or (x ->> 'purpose') not in ('routine', 'plan_review', 'follow_up')
          or char_length(coalesce(x ->> 'focus', '')) > 200
      ) then
        raise exception 'schedule mismatch' using errcode = 'check_violation';
      end if;
      if exists (
        select 1 from jsonb_array_elements(a.structured -> 'rows') x
        where (x ->> 'dueDate')::date < v_today - 1
          or (x ->> 'dueDate')::date > (v_today + interval '6 months')::date + 1
      ) or (
        select count(distinct x ->> 'dueDate') from jsonb_array_elements(a.structured -> 'rows') x
      ) <> jsonb_array_length(a.structured -> 'rows') then
        raise exception 'schedule mismatch' using errcode = 'check_violation';
      end if;

      update visits set status = 'superseded'
        where client_id = a.client_id and origin = 'schedule'
          and ((status in ('planned', 'missed') and due_date > v_today) or status = 'pending_plan');

      select * into v_plan from care_plans p where p.client_id = a.client_id and p.status = 'active';
      for r in
        select (x ->> 'dueDate')::date as due, x ->> 'method' as method, x ->> 'purpose' as purpose,
               nullif(btrim(x ->> 'focus'), '') as focus
          from jsonb_array_elements(a.structured -> 'rows') x
      loop
        if r.purpose = 'plan_review' and v_plan.id is not null
          and abs(r.due - v_plan.review_date) < 7
        then
          select v.id into v_review_visit from visits v
            where v.care_plan_id = v_plan.id and v.purpose = 'plan_review'
              and v.status in ('planned', 'missed')
            order by v.created_at desc limit 1;
          if v_review_visit is not null then
            if r.focus is not null then
              update visits set focus = r.focus where id = v_review_visit;
            end if;
            continue;
          end if;
        end if;
        insert into visits (operator_id, org_id, manager_id, client_id, due_date, method, purpose, focus,
                            origin, source_artifact_id, care_plan_id, status, created_by)
          values (a.operator_id, a.org_id, a.manager_id, a.client_id, r.due, r.method, r.purpose, r.focus,
                  'schedule', a.id, null,
                  case when r.purpose = 'plan_review' then 'pending_plan' else 'planned' end,
                  app_user_id());
        v_count := v_count + 1;
      end loop;
      return v_count;
    end
    $$;
    revoke all on function approve_visit_schedule(uuid) from public;

    -- 随访记录确认（2.9 第 6 条、Q26）：写入 visit_records；关联的随访标为已完成；勾选的跟进项
    -- 标为“已处理（已电话联系）”，必须都是这位客户未处理的跟进项，否则整个事务回滚；
    -- 素材记下整理成的产物，原文在 30 天后删除（Q23）。
    create function approve_visit_record(p_artifact_id uuid, p_follow_up_item_ids uuid[] default '{}')
      returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a artifacts;
      v_ids uuid[] := coalesce(p_follow_up_item_ids, '{}');
      v_record uuid;
      v_date date;
      v_method text;
      v_updated int;
    begin
      if cardinality(v_ids) > 20 or cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
        raise exception 'too many follow-up items' using errcode = 'invalid_parameter_value';
      end if;
      a := m5_lock_draft(p_artifact_id, 'visit_record');
      v_method := a.structured ->> 'method';
      if coalesce(a.structured ->> 'visitDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or v_method is null or v_method not in (${list(S.methods)})
      then
        raise exception 'visit date and method are required' using errcode = 'check_violation';
      end if;
      v_date := (a.structured ->> 'visitDate')::date;
      if v_date > hb_user_today() + 1 then
        raise exception 'visit date cannot be in the future' using errcode = 'check_violation';
      end if;

      insert into visit_records (operator_id, org_id, manager_id, client_id, visit_id, artifact_id,
                                 visit_date, method, snapshot, approved_by)
        values (a.operator_id, a.org_id, a.manager_id, a.client_id, a.visit_id, a.id, v_date, v_method,
                a.structured, app_user_id())
        returning id into v_record;

      if a.visit_id is not null then
        update visits set status = 'done', record_id = v_record, done_at = now()
          where id = a.visit_id and client_id = a.client_id and status in ('planned', 'missed');
      end if;

      if cardinality(v_ids) > 0 then
        update follow_up_items set status = 'done', resolution = 'called', snooze_until = null,
            resolved_by = app_user_id(), resolved_at = now()
          where id = any (v_ids) and client_id = a.client_id and manager_id = app_user_id()
            and status in ('open', 'snoozed');
        get diagnostics v_updated = row_count;
        if v_updated <> cardinality(v_ids) then
          raise exception 'follow-up item not found' using errcode = 'no_data_found';
        end if;
      end if;

      if a.material_ids is not null then
        update visit_materials set consumed_artifact_id = a.id, purge_after = now() + interval '30 days'
          where id = any (a.material_ids) and client_id = a.client_id and purged_at is null;
      end if;
      return v_record;
    end
    $$;
    revoke all on function approve_visit_record(uuid, uuid[]) from public;

    -- 清理到期的素材原文（Q23）：只给后台任务用，带用户身份的会话调用时拒绝。只返回删了几份
    create function visit_materials_purge_due(p_limit int default 500) returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      n int;
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'background jobs only' using errcode = 'insufficient_privilege';
      end if;
      update visit_materials set text_encrypted = null, purged_at = now()
        where id in (
          select id from visit_materials
          where purged_at is null and purge_after <= now()
          order by purge_after
          limit least(greatest(p_limit, 0), 5000)
          for update skip locked
        );
      get diagnostics n = row_count;
      return n;
    end
    $$;
    revoke all on function visit_materials_purge_due(int) from public;

    grant execute on function approve_care_plan(uuid), approve_visit_schedule(uuid),
      approve_visit_record(uuid, uuid[]), visit_materials_purge_due(int) to ${app};
  `.execute(db);

  // 授权：方案只开放结束相关的列；随访只开放处理相关的列；素材只有上传和删除；
  // 记录、记录事件只读；补充说明和同意只追加。都不授予 delete（素材除外）
  await sql`
    grant select on care_plans to ${app};
    grant update (status, end_reason, ended_by, ended_at) on care_plans to ${app};
    grant select, insert on visits to ${app};
    grant update (due_date, method, focus, status, cancel_reason, note, record_id, rescheduled_from, done_at)
      on visits to ${app};
    grant select, insert on client_record_consents to ${app};
    grant select, insert, delete on visit_materials to ${app};
    grant select on visit_records, visit_events to ${app};
    grant select, insert on visit_record_addenda to ${app};
  `.execute(db);

  // 客户转出或删除（Q30）：沿用 0019，另外在产物和客户断开之前，把方案、随访、记录、素材里
  // 对原健管师产物的引用置空（新健管师看不到原健管师的产物）；素材原文删除；
  // 原健管师产物里关联的随访和素材、消息里 @ 的素材也置空
  await sql`
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
      update care_plans set artifact_id = null
        where client_id = p_client_id and artifact_id is not null;
      update visits set source_artifact_id = null
        where client_id = p_client_id and source_artifact_id is not null;
      update visit_records set artifact_id = null
        where client_id = p_client_id and artifact_id is not null;
      update visit_materials set consumed_artifact_id = null,
          text_encrypted = null, purged_at = coalesce(purged_at, now())
        where client_id = p_client_id;

      -- 原健管师的产物不再指向这位客户的报告、随访和素材（这些跟着客户走）
      update artifacts set source_report_id = null, visit_id = null, material_ids = null
        where (source_report_id is not null or visit_id is not null or material_ids is not null)
          and (client_id = p_client_id
               or task_id in (select t.id from tasks t where t.client_id = p_client_id));

      update task_messages set client_refs = '{}', report_refs = '{}', material_refs = '{}'
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
