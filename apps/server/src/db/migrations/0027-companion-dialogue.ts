import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';
import { COMPANION_ENUM_SNAPSHOT_0024 } from './0024-companion-devices.js';

/**
 * M6 伴侣“福宝”第 4 步（规格 2.2、2.4、2.5、2.6、6.2、N9–N11、N19）：对话的会话、聊天文字、记忆，
 * 以及转交和预警的记录（回复、处理的接口和工作台页面在第 6 步）。
 *
 * - 新表都按客户隔离：租户列由 client_record_tenant 触发器从客户行填；设备会话只能读写当前绑定客户的行，
 *   并且设备处于已绑定或已开通（companion_device_can_talk，暂停、撤回同意后什么都读写不了）；
 *   健管师只读自己客户的。机构管理员、运营商、平台没有策略（Q28）。
 * - companion_messages：识别出的文字和福宝说的话，不存音频。purge_after 默认 180 天（N19）；
 *   撤回同意时改为 7 天后（Q5）。删除只经 companion_purge（定时任务，没有租户上下文时调用）。
 * - companion_memories：每条不超过 100 字，每位客户最多 100 条，超出时触发器删最旧的（规格 2.6）。
 *   设备可以删（客户说“忘掉……”，N11）。撤回同意时同样 7 天后删除。
 * - companion_handoffs、companion_alerts：福宝说“已经转给健管师了”时写一条，设备只能新增。
 * - companion_device_profile()：设备角色对 clients、visits 没有策略，只经这个函数读称呼、年龄段、
 *   下一次随访的日期和方式（规格 2.6 能读的部分；不含随访重点和话术）。
 * - 新增固定话术 memory_forgotten、memory_forget_confirm（N11）。
 */

/** 迁移时的固定话术种类快照（有测试对照 packages/shared） */
export const COMPANION_SCRIPT_KINDS_0027 = [
  ...COMPANION_ENUM_SNAPSHOT_0024.scriptKinds,
  'memory_forgotten',
  'memory_forget_confirm',
] as const;

/** 新增话术第 1 版（候选，待审定）；有测试对照 COMPANION_DEFAULT_SCRIPTS */
export const COMPANION_SCRIPTS_SNAPSHOT_0027: Readonly<Record<string, string>> = {
  memory_forgotten: '好的，这件事我不记了。',
  memory_forget_confirm: '您是要我把记住的您的事全都忘掉吗？是的话请再说一遍“全都忘掉”。',
};

export const COMPANION_HANDOFF_CATEGORIES_0027 = [
  'medication',
  'symptom',
  'diagnosis',
  'exam',
  'other',
] as const;
export const COMPANION_ALERT_CATEGORIES_0027 = ['crisis', 'emergency', 'critical_value'] as const;

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

  // ---------- 1. 新增固定话术 ----------
  await sql`
    alter table companion_scripts drop constraint companion_scripts_kind_check;
    alter table companion_scripts add constraint companion_scripts_kind_check
      check (kind in (${list(COMPANION_SCRIPT_KINDS_0027)}));
  `.execute(db);
  for (const [kind, text] of Object.entries(COMPANION_SCRIPTS_SNAPSHOT_0027)) {
    await sql`insert into companion_scripts (kind, version, text) values (${kind}, 1, ${text})`.execute(
      db,
    );
  }

  // ---------- 2. 会话、聊天文字、记忆、转交、预警 ----------
  await sql`
    create table companion_sessions (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      device_id uuid not null references companion_devices (id),
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      turns int not null default 0 check (turns >= 0),
      -- 后台整理生成的摘要（不含病名、药名的口语化概述），给之后的对话做上下文
      summary text check (char_length(summary) <= 500),
      summarized_at timestamptz,
      ${TENANT_FKS}
    );
    create index companion_sessions_client_idx on companion_sessions (client_id, started_at desc);

    create table companion_messages (
      id bigint generated always as identity primary key,
      ${TENANT_COLUMNS}
      session_id uuid not null references companion_sessions (id) on delete cascade,
      role text not null check (role in ('client', 'companion')),
      kind text not null check (kind in ('chat', 'script')),
      script_kind text check (script_kind in (${list(COMPANION_SCRIPT_KINDS_0027)})),
      content text not null check (char_length(content) between 1 and 2000),
      -- 这一句触发了什么：crisis / emergency / handoff / fallback / rate_limited / forget
      signals text[] not null default '{}'
        check (signals <@ array['crisis', 'emergency', 'handoff', 'fallback', 'rate_limited', 'forget']),
      created_at timestamptz not null default now(),
      purge_after timestamptz not null default now() + interval '180 days',
      check ((kind = 'script') = (script_kind is not null)),
      check (role = 'companion' or kind = 'chat'),
      ${TENANT_FKS}
    );
    create index companion_messages_client_idx on companion_messages (client_id, created_at desc);
    create index companion_messages_session_idx on companion_messages (session_id, id);
    create index companion_messages_purge_idx on companion_messages (purge_after);

    create table companion_memories (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      text text not null check (char_length(btrim(text)) between 1 and 100),
      source_session_id uuid references companion_sessions (id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      purge_after timestamptz,
      ${TENANT_FKS}
    );
    create index companion_memories_client_idx on companion_memories (client_id, created_at desc);

    create table companion_handoffs (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      message_id bigint references companion_messages (id) on delete set null,
      category text not null check (category in (${list(COMPANION_HANDOFF_CATEGORIES_0027)})),
      -- 客户问的原话（识别出的文字，已去掉电话、证件号），给健管师看
      question text not null check (char_length(question) between 1 and 500),
      -- trigger：rule（规则识别）/ model（模型判断）/ fallback（输出检查不通过）
      trigger text not null check (trigger in ('rule', 'model', 'fallback')),
      status text not null default 'open'
        check (status in ('open', 'replied', 'closed_by_call', 'closed')),
      created_at timestamptz not null default now(),
      ${TENANT_FKS}
    );
    create index companion_handoffs_client_idx on companion_handoffs (client_id, created_at desc);
    create index companion_handoffs_manager_open_idx on companion_handoffs (manager_id) where status = 'open';

    create table companion_alerts (
      id uuid primary key default gen_random_uuid(),
      ${TENANT_COLUMNS}
      message_id bigint references companion_messages (id) on delete set null,
      category text not null check (category in (${list(COMPANION_ALERT_CATEGORIES_0027)})),
      trigger text not null check (trigger in ('keyword', 'model', 'threshold')),
      script_version int check (script_version >= 1),
      status text not null default 'open' check (status in ('open', 'handled')),
      created_at timestamptz not null default now(),
      ${TENANT_FKS}
    );
    create index companion_alerts_client_idx on companion_alerts (client_id, created_at desc);
    create index companion_alerts_manager_open_idx on companion_alerts (manager_id) where status = 'open';
  `.execute(db);

  // ---------- 3. 行级安全 ----------
  const device = sql`app_role() = 'companion_device' and client_id = app_client_id() and companion_device_can_talk()`;
  const manager = sql`app_role() = 'manager' and manager_id = app_user_id()`;
  for (const table of [
    'companion_sessions',
    'companion_messages',
    'companion_memories',
    'companion_handoffs',
    'companion_alerts',
  ]) {
    const t = sql.table(table);
    const p = (suffix: string) => sql.id(`${table}_${suffix}`);
    await sql`
      alter table ${t} enable row level security;
      create trigger ${p('tenant')} before insert or update on ${t}
        for each row execute function client_record_tenant();
      create policy ${p('manager_select')} on ${t} for select using (${manager});
      create policy ${p('device_select')} on ${t} for select using (${device});
      create policy ${p('device_insert')} on ${t} for insert with check (${device});
    `.execute(db);
  }
  await sql`
    -- 会话：设备结束会话、记轮数、写摘要；消息、转交、预警只能新增
    create policy companion_sessions_device_update on companion_sessions for update
      using (app_role() = 'companion_device' and client_id = app_client_id() and companion_device_can_talk())
      with check (app_role() = 'companion_device' and client_id = app_client_id());
    -- 设备的会话只能记在自己这台设备上
    create function companion_sessions_device_guard() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() = 'companion_device' and new.device_id is distinct from app_device_id() then
        raise exception 'session device mismatch' using errcode = '42501';
      end if;
      return new;
    end
    $$;
    revoke all on function companion_sessions_device_guard() from public;
    create trigger companion_sessions_device_guard before insert or update on companion_sessions
      for each row execute function companion_sessions_device_guard();
    -- 客户说“忘掉……”时删除记忆（N11）
    create policy companion_memories_device_delete on companion_memories for delete
      using (app_role() = 'companion_device' and client_id = app_client_id() and companion_device_can_talk());

    grant select, insert on companion_sessions to ${app};
    grant update (ended_at, turns, summary, summarized_at) on companion_sessions to ${app};
    grant select on companion_messages to ${app};
    grant insert (client_id, session_id, role, kind, script_kind, content, signals) on companion_messages to ${app};
    grant select, delete on companion_memories to ${app};
    grant insert (client_id, text, source_session_id) on companion_memories to ${app};
    grant select on companion_handoffs to ${app};
    grant insert (client_id, message_id, category, question, trigger) on companion_handoffs to ${app};
    grant select on companion_alerts to ${app};
    grant insert (client_id, message_id, category, trigger, script_version) on companion_alerts to ${app};
  `.execute(db);

  // ---------- 4. 记忆上限、撤回同意后删除、清理 ----------
  await sql`
    -- 每位客户最多 100 条记忆，超出时删最旧的（规格 2.6）
    create function companion_memories_cap() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      delete from companion_memories
        where id in (
          select id from companion_memories where client_id = new.client_id
            order by created_at desc, id desc offset 100
        );
      return null;
    end
    $$;
    revoke all on function companion_memories_cap() from public;
    create trigger companion_memories_cap after insert on companion_memories
      for each row execute function companion_memories_cap();

    -- 撤回同意 → 聊天文字和记忆 7 天后删除（Q5）；之后新写入的不受影响（撤回后设备什么都写不了）
    create function companion_consents_purge_schedule() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if new.action = 'revoke' then
        update companion_messages set purge_after = least(purge_after, now() + interval '7 days')
          where client_id = new.client_id;
        update companion_memories
          set purge_after = least(coalesce(purge_after, 'infinity'), now() + interval '7 days')
          where client_id = new.client_id;
      end if;
      return null;
    end
    $$;
    revoke all on function companion_consents_purge_schedule() from public;
    create trigger companion_consents_purge_schedule after insert on companion_consents
      for each row execute function companion_consents_purge_schedule();

    -- 定时清理（没有租户上下文时由后台任务调用）：删掉到期的聊天文字和记忆，返回删除条数
    create function companion_purge() returns table (messages int, memories int)
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      m int;
      r int;
    begin
      if app_role() is not null then
        raise exception 'companion purge only without tenant context' using errcode = '42501';
      end if;
      delete from companion_messages where purge_after <= now();
      get diagnostics m = row_count;
      delete from companion_memories where purge_after <= now();
      get diagnostics r = row_count;
      return query select m, r;
    end
    $$;
    revoke all on function companion_purge() from public;
    grant execute on function companion_purge() to ${app};
  `.execute(db);

  // ---------- 5. 设备会话读客户资料（规格 2.6） ----------
  await sql`
    create function companion_device_profile()
      returns table (name_for_client text, age_band text, next_visit_on date, next_visit_method text)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select c.companion_name_for_client,
        case when c.birth_year is null then null
          else (floor((extract(year from now() at time zone 'Asia/Shanghai') - c.birth_year) / 10) * 10)::int
            || '-' || ((floor((extract(year from now() at time zone 'Asia/Shanghai') - c.birth_year) / 10) * 10)::int + 9)
        end,
        v.due_date, v.method
      from clients c
      left join lateral (
        select due_date, method from visits
          where client_id = c.id and status = 'planned'
            and due_date >= (now() at time zone 'Asia/Shanghai')::date
          order by due_date limit 1
      ) v on true
      where c.id = app_client_id() and companion_device_can_talk()
    $$;
    revoke all on function companion_device_profile() from public;
    grant execute on function companion_device_profile() to ${app};
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
