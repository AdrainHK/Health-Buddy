import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 第 2 步：已审核产物“同步给伴侣”（规格 2.8、6.2、N12，红线 3），以及第 1 步同意记录的补强。
 *
 * 同步给伴侣：
 * - companion_deliveries：同步时复制的通俗版快照（含免责声明），福宝回答问题时只读这些。
 *   同一位客户同一种类只有一份在用：再同步新的，旧的标记为已替代；健管师可以取消同步。
 *   客户转出时跟着客户走（Q27）。
 * - 只经 SECURITY DEFINER 函数写入：sync_artifact_to_companion 重新校验当前健管师服务这位客户、
 *   产物已审核且是这条产物链最新的已审核版本、方案是当前生效的方案、客户有有效同意且设备已绑定没撤回、
 *   传入的快照和产物通俗版一字不差；withdraw_companion_delivery 取消同步。应用角色没有写权限。
 * - 设备会话只能读这位客户在用的快照，且设备处于已绑定或已开通状态（暂停、撤回同意后读不到）。
 * - artifact_events 加动作 companion_synced、companion_withdrawn（产物的“记录”标签）。
 *
 * 同意记录（合规复审）：
 * - companion_consents 加 chat_data_confirmed：记录同意时必须另外确认“已单独告知对话会转成文字保存、
 *   健管师能看到、家人说的话也可能被记录、撤回后 7 天删除”。
 * - 只能按平台当前的告知书版本记录同意；同意日期不早于这版告知书的发布日期；撤回日期不早于同意日期。
 * - 撤回时记下设备原来的状态（revoked_from），重新同意后回到原来的状态（原来暂停的仍是暂停）。
 */

/** 可以同步给伴侣的产物种类（Q12：方案和解读的通俗版）；有测试对照 COMPANION_DELIVERY_KINDS */
export const COMPANION_DELIVERY_KINDS_0025 = ['care_plan', 'report_interpretation'] as const;

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
];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  const kinds = list(COMPANION_DELIVERY_KINDS_0025);

  // ---------- 1. 同步给伴侣的快照 ----------
  await sql`
    create table companion_deliveries (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      artifact_id uuid not null unique,
      kind text not null check (kind in (${kinds})),
      -- 同步时的通俗版快照（含免责声明），含健康内容，不进日志
      content text not null check (char_length(content) between 1 and 20000),
      sent_by uuid not null references users (id),
      sent_at timestamptz not null default now(),
      -- 同一位客户同一种类再同步新的时，旧的被替代
      superseded_at timestamptz,
      withdrawn_at timestamptz,
      withdrawn_by uuid references users (id),
      check ((withdrawn_at is null) = (withdrawn_by is null)),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index companion_deliveries_client_idx on companion_deliveries (client_id, sent_at desc);

    -- 设备当前能不能对话：已绑定或已开通（暂停、撤回同意后不能读任何客户内容）
    create function companion_device_can_talk() returns boolean
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select exists (
        select 1 from companion_devices d
          where app_role() = 'companion_device' and d.id = app_device_id()
            and d.status in ('bound', 'active')
      )
    $$;
    revoke all on function companion_device_can_talk() from public;
    grant execute on function companion_device_can_talk() to ${app};

    alter table companion_deliveries enable row level security;
    create trigger companion_deliveries_tenant before insert or update on companion_deliveries
      for each row execute function client_record_tenant();
    create policy companion_deliveries_manager_select on companion_deliveries for select
      using (app_role() = 'manager' and manager_id = app_user_id());
    create policy companion_deliveries_device_select on companion_deliveries for select
      using (
        app_role() = 'companion_device' and client_id = app_client_id()
        and superseded_at is null and withdrawn_at is null and companion_device_can_talk()
      );
    grant select on companion_deliveries to ${app};

    alter table artifact_events drop constraint artifact_events_action_check;
    alter table artifact_events add constraint artifact_events_action_check check (
      action in ('created', 'edited', 'approved', 'returned', 'voided', 'copied', 'exported',
                 'companion_synced', 'companion_withdrawn')
    );
  `.execute(db);

  await sql`
    -- 结果：ok / already（在用）/ not_found / not_approved / wrong_kind / not_latest（这条产物链有更新的
    -- 已审核版本）/ not_current_plan（方案不是当前生效的）/ no_companion（没有有效同意或设备）/ content_mismatch
    create function sync_artifact_to_companion(p_artifact_id uuid, p_content text) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a record;
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      select ar.id, ar.client_id, ar.kind, ar.status, ar.content, ar.lineage_id, ar.version,
             ar.operator_id, ar.org_id, ar.manager_id
        into a
        from artifacts ar
        where ar.id = p_artifact_id and ar.manager_id = app_user_id()
        for update;
      if not found or a.client_id is null then
        return 'not_found';
      end if;
      -- 锁住客户行，和并发的转出串行；客户必须仍由当前健管师服务
      perform 1 from clients where id = a.client_id and manager_id = app_user_id() for update;
      if not found then
        return 'not_found';
      end if;
      if a.status <> 'approved' then
        return 'not_approved';
      end if;
      if a.kind not in (${kinds}) then
        return 'wrong_kind';
      end if;
      if exists (
        select 1 from artifacts x
          where x.lineage_id = a.lineage_id and x.version > a.version and x.status = 'approved'
      ) then
        return 'not_latest';
      end if;
      if a.kind = 'care_plan' and not exists (
        select 1 from care_plans p where p.artifact_id = a.id and p.status = 'active'
      ) then
        return 'not_current_plan';
      end if;
      if not companion_consent_active(a.client_id) or not exists (
        select 1 from companion_devices
          where client_id = a.client_id and status in ('bound', 'active', 'paused')
      ) then
        return 'no_companion';
      end if;
      if p_content is distinct from (a.content ->> 'clientFacing') then
        return 'content_mismatch';
      end if;
      if exists (
        select 1 from companion_deliveries
          where artifact_id = a.id and withdrawn_at is null and superseded_at is null
      ) then
        return 'already';
      end if;
      update companion_deliveries set superseded_at = now()
        where client_id = a.client_id and kind = a.kind and artifact_id <> a.id
          and superseded_at is null and withdrawn_at is null;
      insert into companion_deliveries (client_id, artifact_id, kind, content, sent_by)
        values (a.client_id, a.id, a.kind, p_content, app_user_id())
        on conflict (artifact_id) do update set
          content = excluded.content, sent_by = excluded.sent_by, sent_at = now(),
          superseded_at = null, withdrawn_at = null, withdrawn_by = null;
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        values (a.id, a.operator_id, a.org_id, a.manager_id, app_user_id(), 'companion_synced');
      return 'ok';
    end
    $$;
    revoke all on function sync_artifact_to_companion(uuid, text) from public;

    -- 取消同步：ok / not_found / not_synced
    create function withdraw_companion_delivery(p_artifact_id uuid) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a record;
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      select ar.id, ar.client_id, ar.operator_id, ar.org_id, ar.manager_id into a
        from artifacts ar where ar.id = p_artifact_id and ar.manager_id = app_user_id();
      if not found or a.client_id is null then
        return 'not_found';
      end if;
      perform 1 from clients where id = a.client_id and manager_id = app_user_id() for update;
      if not found then
        return 'not_found';
      end if;
      update companion_deliveries set withdrawn_at = now(), withdrawn_by = app_user_id()
        where artifact_id = a.id and withdrawn_at is null and superseded_at is null;
      if not found then
        return 'not_synced';
      end if;
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        values (a.id, a.operator_id, a.org_id, a.manager_id, app_user_id(), 'companion_withdrawn');
      return 'ok';
    end
    $$;
    revoke all on function withdraw_companion_delivery(uuid) from public;

    grant execute on function
      sync_artifact_to_companion(uuid, text),
      withdraw_companion_delivery(uuid)
      to ${app};
  `.execute(db);

  // ---------- 2. 同意记录的补强（合规复审） ----------
  await sql`
    alter table companion_consents
      add column chat_data_confirmed boolean not null default false;

    alter table companion_devices
      add column revoked_from text check (revoked_from in ('bound', 'active', 'paused'));
    -- 0024 上线后已撤回的设备没有记原来的状态，按是否激活过补上
    update companion_devices
      set revoked_from = case when activated_at is null then 'bound' else 'active' end
      where status = 'revoked';
    alter table companion_devices add constraint companion_devices_revoked_from
      check ((status = 'revoked') = (revoked_from is not null));

    create or replace function companion_consents_guard() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      notice record;
      consented_on date;
    begin
      -- 先确认是自己的客户，再给出其他报错：不能借报错判断别人的客户有没有有效同意
      if app_role() is not null and not exists (
        select 1 from clients where id = new.client_id and manager_id = app_user_id()
      ) then
        raise exception 'not your client' using errcode = '42501';
      end if;
      if new.action = 'consent' then
        -- 只能按平台当前的告知书版本；同意日期不早于这版的发布日期；必须单独确认了聊天数据的使用
        select version, (created_at at time zone 'Asia/Shanghai')::date as published_on into notice
          from companion_scripts where kind = 'notice' order by version desc limit 1;
        if not found or new.notice_version <> notice.version then
          raise exception 'companion notice version is not current' using errcode = '23514';
        end if;
        if new.effective_on < notice.published_on then
          raise exception 'consent date before notice publication' using errcode = '23514';
        end if;
        if not new.chat_data_confirmed then
          raise exception 'chat data use not confirmed' using errcode = '23514';
        end if;
      else
        if not companion_consent_active(new.client_id) then
          raise exception 'companion consent is not active' using errcode = '23514';
        end if;
        select effective_on into consented_on from companion_consents
          where client_id = new.client_id order by id desc limit 1;
        if new.effective_on < consented_on then
          raise exception 'revoke date before consent date' using errcode = '23514';
        end if;
      end if;
      return new;
    end
    $$;

    -- 撤回 → 设备只播暂停话术，记下原来的状态；重新同意 → 回到原来的状态
    create or replace function companion_consents_apply() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if new.action = 'revoke' then
        update companion_devices set revoked_from = status, status = 'revoked'
          where client_id = new.client_id and status in ('bound', 'active', 'paused');
      else
        update companion_devices set status = revoked_from, revoked_from = null
          where client_id = new.client_id and status = 'revoked';
      end if;
      return null;
    end
    $$;

    create or replace function companion_device_release(p_client_id uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      update companion_devices set
          status = 'stock', revoked_from = null,
          operator_id = null, org_id = null, manager_id = null, client_id = null,
          bound_by = null, bound_at = null, activated_at = null, last_seen_at = null
        where client_id = p_client_id;
      return found;
    end
    $$;
  `.execute(db);

  // ---------- 3. 客户换机构时同步租户列（加上本迁移的表） ----------
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
