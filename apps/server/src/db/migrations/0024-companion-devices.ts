import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 AI 健康伴侣“福宝”第 1 步（规格 3.2、3.4、6.2、2.10）：设备、线下告知和同意、伴侣设置、平台固定话术。
 * 对话、记忆、收集信息、转交、预警、打卡等表在用到它们的步骤里再加。
 *
 * - 新会话角色 companion_device：后端用设备令牌换出客户后设置 app.role = 'companion_device'、
 *   app.device_id、app.client_id（新增 app_device_id()、app_client_id()）。已有的表都没有给这个角色的策略，
 *   默认拒绝（验收标准 20）；本迁移只给它“读自己这台设备”和“读固定话术”。
 * - companion_device_batches、companion_devices：平台按批次导入出厂设备（N2），只存设备密钥的 SHA-256
 *   和激活码的 argon2id 哈希。设备没有绑定时没有租户列；绑定、解绑、暂停、恢复只经 SECURITY DEFINER 函数，
 *   应用角色对设备表没有 update、delete 权限。平台只能经统计函数看每批的绑定数，看不到设备绑给了谁。
 * - companion_consents：线下告知和同意、撤回的记录（Q4、Q5、N4），只能追加；最新一行决定当前是否同意。
 *   撤回时设备转为 revoked（只播暂停话术），重新同意后恢复。没有有效同意时不能绑定。
 * - companion_scripts：平台维护的固定话术和线下告知书模板（Q22、N4），每次保存是一个新版本，只能追加。
 * - clients 加伴侣称呼、语速、音量（Q7、N17）。
 * - 机构管理员、运营商、平台对设备和同意记录都没有策略（Q28）。
 */

/** 迁移时的固定取值快照（迁移发布后不能改，有测试对照 packages/shared） */
export const COMPANION_ENUM_SNAPSHOT_0024 = {
  deviceStatuses: ['stock', 'bound', 'active', 'paused', 'revoked'],
  voiceSpeeds: ['slow', 'medium', 'fast'],
  volumes: ['low', 'medium', 'high'],
  scriptKinds: [
    'intro',
    'daily_intro',
    'crisis',
    'emergency',
    'critical_value',
    'handoff',
    'fallback',
    'paused',
    'rate_limited',
    'asr_retry',
    'handoff_reply_intro',
    'reminder_medication',
    'reminder_measurement',
    'reminder_exercise',
    'notice',
  ],
} as const;

/** 固定话术第 1 版（候选，待审定）；有测试对照 COMPANION_DEFAULT_SCRIPTS */
export const COMPANION_SCRIPTS_SNAPSHOT_0024: Readonly<Record<string, string>> = {
  intro:
    '您好，我是 AI 伴侣福宝，不是医生，不能替代看病。我可以陪您聊天，提醒您吃药、量血压，有问题我会转给您的健管师。',
  daily_intro: '我是 AI 伴侣福宝，不是医生。',
  crisis: '请马上联系家人，或拨打 120；也可以拨打当地的心理援助热线。',
  emergency: '请马上拨打 120 或让家人送医。',
  critical_value: '这个数值需要尽快告诉医生，我已经通知您的健管师了。',
  handoff: '这个问题需要健管师或医生来回答，我已经帮您转给您的健管师了。',
  fallback: '这个问题我回答不好，已经帮您转给健管师了。',
  paused: '伴侣已暂停，请联系你的健管师。',
  rate_limited: '今天聊得很多了，休息一下吧。',
  asr_retry: '我没听清，您能再说一遍吗？',
  handoff_reply_intro: '您的健管师回复了您之前问的问题。',
  reminder_medication: '该按医嘱吃药了，吃了吗？',
  reminder_measurement: '该记一下今天的{metric}了，您告诉我数就行。',
  reminder_exercise: '今天的运动做了吗？',
};

/** 客户相关的表，客户换机构时同步租户列（0020 的列表，加上本迁移的表） */
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
];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  const S = COMPANION_ENUM_SNAPSHOT_0024;

  // ---------- 1. 设备会话的上下文 ----------
  await sql`
    create function app_device_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.device_id', true), '')::uuid $$;
    create function app_client_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.client_id', true), '')::uuid $$;
    grant execute on function app_device_id(), app_client_id() to ${app};
  `.execute(db);

  // ---------- 2. 伴侣设置（Q7、N17） ----------
  await sql`
    alter table clients
      add column companion_name_for_client text
        check (char_length(btrim(companion_name_for_client)) between 1 and 10),
      add column companion_voice_speed text not null default 'slow'
        check (companion_voice_speed in (${list(S.voiceSpeeds)})),
      add column companion_volume text not null default 'medium'
        check (companion_volume in (${list(S.volumes)}));
  `.execute(db);

  // ---------- 3. 设备 ----------
  await sql`
    create table companion_device_batches (
      id uuid primary key default gen_random_uuid(),
      name text not null check (char_length(btrim(name)) between 1 and 60),
      device_count int not null check (device_count between 1 and 1000),
      imported_by uuid not null references users (id),
      imported_at timestamptz not null default now()
    );

    create table companion_devices (
      id uuid primary key default gen_random_uuid(),
      serial_no text not null unique check (serial_no ~ '^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$'),
      -- 设备密钥是高熵随机串，存 SHA-256 便于每次连接查找；激活码位数少，存 argon2id（含盐）
      secret_hash bytea not null unique check (octet_length(secret_hash) = 32),
      activation_code_hash text not null check (char_length(activation_code_hash) between 16 and 300),
      batch_id uuid not null references companion_device_batches (id),
      status text not null default 'stock' check (status in (${list(S.deviceStatuses)})),
      -- 绑定后才有租户列，跟着客户走（Q27）
      operator_id uuid references operators (id),
      org_id uuid,
      manager_id uuid,
      client_id uuid unique,
      bound_by uuid references users (id),
      bound_at timestamptz,
      activated_at timestamptz,
      last_seen_at timestamptz,
      firmware_version text check (char_length(firmware_version) between 1 and 64),
      created_at timestamptz not null default now(),
      foreign key (client_id, manager_id) references clients (id, manager_id) on update cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint companion_devices_binding check (
        (status = 'stock') = (client_id is null)
        and (client_id is null) = (operator_id is null)
        and (client_id is null) = (manager_id is null)
        and (client_id is null) = (bound_at is null)
        and (client_id is not null or (org_id is null and bound_by is null and activated_at is null))
      )
    );
    create index companion_devices_batch_idx on companion_devices (batch_id);
    create index companion_devices_manager_idx on companion_devices (manager_id) where manager_id is not null;
  `.execute(db);

  // ---------- 4. 线下告知和同意（Q4、Q5、N4） ----------
  await sql`
    create table companion_consents (
      id bigint generated always as identity primary key,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      action text not null check (action in ('consent', 'revoke')),
      notice_version int check (notice_version >= 1),
      effective_on date not null,
      recorded_by uuid not null references users (id),
      created_at timestamptz not null default clock_timestamp(),
      check ((action = 'consent') = (notice_version is not null)),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index companion_consents_client_idx on companion_consents (client_id, id desc);
  `.execute(db);

  // ---------- 5. 固定话术和告知书模板（Q22、N4） ----------
  await sql`
    create table companion_scripts (
      id uuid primary key default gen_random_uuid(),
      kind text not null check (kind in (${list(S.scriptKinds)})),
      version int not null check (version >= 1),
      text text not null check (char_length(btrim(text)) between 1 and 10000),
      created_by uuid references users (id),
      created_at timestamptz not null default now(),
      unique (kind, version),
      -- 念出来的话术要短，告知书模板是打印用的长文
      check (kind = 'notice' or char_length(text) <= 300)
    );

    -- 版本号由触发器按种类加一，同一种类串行
    create function companion_scripts_version() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      perform pg_advisory_xact_lock(hashtext('companion_scripts:' || new.kind));
      select coalesce(max(version), 0) + 1 into new.version from companion_scripts where kind = new.kind;
      new.created_at := now();
      return new;
    end
    $$;
    revoke all on function companion_scripts_version() from public;
    create trigger companion_scripts_version before insert on companion_scripts
      for each row execute function companion_scripts_version();
  `.execute(db);
  for (const [kind, text] of Object.entries(COMPANION_SCRIPTS_SNAPSHOT_0024)) {
    await sql`insert into companion_scripts (kind, version, text) values (${kind}, 1, ${text})`.execute(
      db,
    );
  }

  // ---------- 6. 行级安全 ----------
  const managerUsing = sql`app_role() = 'manager' and manager_id = app_user_id()`;
  const managerCheck = sql`
    app_role() = 'manager' and manager_id = app_user_id()
    and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
  `;
  await sql`
    alter table companion_device_batches enable row level security;
    alter table companion_devices enable row level security;
    alter table companion_consents enable row level security;
    alter table companion_scripts enable row level security;

    create policy companion_device_batches_platform on companion_device_batches for all
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and imported_by = app_user_id());

    -- 平台只能导入库存设备；读设备只有绑定了它的健管师和这台设备自己
    create policy companion_devices_platform_insert on companion_devices for insert
      with check (app_role() = 'platform_admin' and status = 'stock' and client_id is null);
    create policy companion_devices_manager_select on companion_devices for select
      using (${managerUsing});
    create policy companion_devices_device_select on companion_devices for select
      using (app_role() = 'companion_device' and id = app_device_id());

    create policy companion_consents_manager_select on companion_consents for select
      using (${managerUsing});
    create policy companion_consents_manager_insert on companion_consents for insert
      with check (${managerCheck} and recorded_by = app_user_id());
    create trigger companion_consents_tenant before insert or update on companion_consents
      for each row execute function client_record_tenant();

    create policy companion_scripts_select on companion_scripts for select using (
      app_role() in ('platform_admin', 'operator_admin', 'org_admin', 'manager', 'companion_device')
    );
    create policy companion_scripts_platform_insert on companion_scripts for insert
      with check (app_role() = 'platform_admin' and created_by = app_user_id());

    grant select, insert on companion_device_batches to ${app};
    grant select on companion_devices to ${app};
    grant insert (serial_no, secret_hash, activation_code_hash, batch_id) on companion_devices to ${app};
    grant select, insert on companion_consents to ${app};
    grant select on companion_scripts to ${app};
    grant insert (kind, text, created_by) on companion_scripts to ${app};
  `.execute(db);

  // ---------- 7. 同意记录的校验和设备状态联动 ----------
  await sql`
    -- 当前是否同意：最新一条记录是“同意”
    create function companion_consent_active(p_client_id uuid) returns boolean
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select coalesce(
        (select action = 'consent' from companion_consents
          where client_id = p_client_id order by id desc limit 1),
        false)
    $$;
    revoke all on function companion_consent_active(uuid) from public;

    create function companion_consents_guard() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if new.action = 'consent' then
        if not exists (
          select 1 from companion_scripts where kind = 'notice' and version = new.notice_version
        ) then
          raise exception 'companion notice version does not exist' using errcode = '23514';
        end if;
      elsif not companion_consent_active(new.client_id) then
        raise exception 'companion consent is not active' using errcode = '23514';
      end if;
      return new;
    end
    $$;
    revoke all on function companion_consents_guard() from public;
    create trigger companion_consents_guard before insert on companion_consents
      for each row execute function companion_consents_guard();

    -- 只能追加
    create function companion_consents_append_only() returns trigger language plpgsql as $$
    begin
      raise exception 'companion_consents is append-only' using errcode = '42501';
    end
    $$;
    create trigger companion_consents_append_only before update or delete on companion_consents
      for each row when (pg_trigger_depth() = 0)
      execute function companion_consents_append_only();

    -- 撤回 → 设备只播暂停话术（Q5）；重新同意 → 恢复
    create function companion_consents_apply() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if new.action = 'revoke' then
        update companion_devices set status = 'revoked'
          where client_id = new.client_id and status in ('bound', 'active', 'paused');
      else
        update companion_devices
          set status = case when activated_at is null then 'bound' else 'active' end
          where client_id = new.client_id and status = 'revoked';
      end if;
      return null;
    end
    $$;
    revoke all on function companion_consents_apply() from public;
    create trigger companion_consents_apply after insert on companion_consents
      for each row execute function companion_consents_apply();
  `.execute(db);

  // ---------- 8. 绑定、解绑、暂停（规格 2.1，只经这些函数改设备） ----------
  await sql`
    -- 绑定前按序列号取设备和激活码哈希（激活码在后端校验）。只给健管师；设备属于谁不返回
    create function companion_device_for_binding(p_serial text)
      returns table (id uuid, status text, activation_code_hash text)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'manager' then
        return;
      end if;
      return query
        select d.id, d.status, d.activation_code_hash from companion_devices d where d.serial_no = p_serial;
    end
    $$;
    revoke all on function companion_device_for_binding(text) from public;

    -- 结果：ok / not_found（不是自己的客户）/ already_bound / no_consent / unavailable
    create function bind_companion_device(p_device_id uuid, p_client_id uuid) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      c record;
      d record;
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      -- 锁住客户行：同一客户的并发绑定、转出串行
      select cl.id, cl.operator_id, cl.org_id, cl.manager_id into c
        from clients cl where cl.id = p_client_id and cl.manager_id = app_user_id() for update;
      if not found then
        return 'not_found';
      end if;
      if exists (select 1 from companion_devices where client_id = p_client_id) then
        return 'already_bound';
      end if;
      if not companion_consent_active(p_client_id) then
        return 'no_consent';
      end if;
      select dv.id, dv.status into d from companion_devices dv where dv.id = p_device_id for update;
      if not found or d.status <> 'stock' then
        return 'unavailable';
      end if;
      update companion_devices set
          status = 'bound',
          operator_id = c.operator_id, org_id = c.org_id, manager_id = c.manager_id, client_id = c.id,
          bound_by = app_user_id(), bound_at = now(),
          activated_at = null, last_seen_at = null, firmware_version = null
        where id = p_device_id;
      return 'ok';
    end
    $$;
    revoke all on function bind_companion_device(uuid, uuid) from public;

    -- 设备回到库存，设备上不存客户数据（3.3），客户的数据留在客户名下
    create function companion_device_release(p_client_id uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      update companion_devices set
          status = 'stock', operator_id = null, org_id = null, manager_id = null, client_id = null,
          bound_by = null, bound_at = null, activated_at = null, last_seen_at = null
        where client_id = p_client_id;
      return found;
    end
    $$;
    revoke all on function companion_device_release(uuid) from public;

    create function unbind_companion_device(p_client_id uuid) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      perform 1 from clients where id = p_client_id and manager_id = app_user_id() for update;
      if not found then
        return 'not_found';
      end if;
      if not companion_device_release(p_client_id) then
        return 'no_device';
      end if;
      return 'ok';
    end
    $$;
    revoke all on function unbind_companion_device(uuid) from public;

    -- 暂停只对已绑定、已开通的设备；恢复回到暂停前（是否已激活决定 bound / active）
    create function set_companion_device_paused(p_client_id uuid, p_paused boolean) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      d record;
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      perform 1 from clients where id = p_client_id and manager_id = app_user_id() for update;
      if not found then
        return 'not_found';
      end if;
      select id, status into d from companion_devices where client_id = p_client_id for update;
      if not found then
        return 'no_device';
      end if;
      if p_paused and d.status in ('bound', 'active') then
        update companion_devices set status = 'paused' where id = d.id;
      elsif not p_paused and d.status = 'paused' then
        update companion_devices
          set status = case when activated_at is null then 'bound' else 'active' end
          where id = d.id;
      elsif (p_paused and d.status = 'paused') or (not p_paused and d.status in ('bound', 'active')) then
        null; -- 已经是目标状态
      else
        return 'invalid_state';
      end if;
      return 'ok';
    end
    $$;
    revoke all on function set_companion_device_paused(uuid, boolean) from public;

    -- 客户删除前先把设备放回库存（否则外键挡住删除）
    create function clients_release_companion_device() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      perform companion_device_release(old.id);
      return old;
    end
    $$;
    revoke all on function clients_release_companion_device() from public;
    create trigger clients_release_companion_device before delete on clients
      for each row execute function clients_release_companion_device();

    -- 平台导入前查哪些序列号已经存在（只给平台管理员）
    create function companion_existing_serials(p_serials text[]) returns setof text
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'platform_admin' then
        return;
      end if;
      return query select serial_no from companion_devices where serial_no = any (p_serials);
    end
    $$;
    revoke all on function companion_existing_serials(text[]) from public;

    -- 平台看每批的绑定数，不看绑给了谁（2.10）
    create function companion_device_batch_stats()
      returns table (id uuid, name text, device_count int, bound_count int, imported_at timestamptz)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'platform_admin' then
        return;
      end if;
      return query
        select b.id, b.name, b.device_count,
               (select count(*)::int from companion_devices d where d.batch_id = b.id and d.status <> 'stock'),
               b.imported_at
          from companion_device_batches b
          order by b.imported_at desc;
    end
    $$;
    revoke all on function companion_device_batch_stats() from public;

    grant execute on function
      companion_device_for_binding(text),
      bind_companion_device(uuid, uuid),
      unbind_companion_device(uuid),
      set_companion_device_paused(uuid, boolean),
      companion_existing_serials(text[]),
      companion_device_batch_stats()
      to ${app};
  `.execute(db);

  // ---------- 9. 客户换机构时同步租户列（加上本迁移的表） ----------
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
