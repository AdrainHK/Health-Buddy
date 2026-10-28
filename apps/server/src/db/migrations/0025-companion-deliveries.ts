import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 第 2 步：已审核产物“同步给伴侣”（规格 2.8、6.2、N12，红线 3）。
 *
 * - companion_deliveries：同步时复制的通俗版快照（含免责声明），福宝回答饮食、运动、作息问题时只读这些。
 *   同一份产物只同步一次（再点一次不重复）。客户转出时跟着客户走（Q27）。
 * - 只经 SECURITY DEFINER 函数 sync_artifact_to_companion 写入：函数里重新校验当前健管师服务这位客户、
 *   产物已审核、种类是方案或报告解读、客户已绑定设备且没有撤回同意、传入的快照和产物通俗版一字不差。
 *   应用角色没有 insert 权限；后端另做通俗版的合规检查（同复制、导出）。
 * - 设备会话只能读这位客户的（client_id = app_client_id()）；机构、协会、平台没有策略（Q28）。
 * - artifact_events 加动作 companion_synced（产物的“记录”标签）。
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
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index companion_deliveries_client_idx on companion_deliveries (client_id, sent_at desc);

    alter table companion_deliveries enable row level security;
    create trigger companion_deliveries_tenant before insert or update on companion_deliveries
      for each row execute function client_record_tenant();
    create policy companion_deliveries_manager_select on companion_deliveries for select
      using (app_role() = 'manager' and manager_id = app_user_id());
    create policy companion_deliveries_device_select on companion_deliveries for select
      using (app_role() = 'companion_device' and client_id = app_client_id());
    grant select on companion_deliveries to ${app};

    alter table artifact_events drop constraint artifact_events_action_check;
    alter table artifact_events add constraint artifact_events_action_check check (
      action in ('created', 'edited', 'approved', 'returned', 'voided', 'copied', 'exported',
                 'companion_synced')
    );
  `.execute(db);

  await sql`
    -- 结果：ok / already（同步过）/ not_found / not_approved / wrong_kind / no_companion / content_mismatch
    create function sync_artifact_to_companion(p_artifact_id uuid, p_content text) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      a record;
    begin
      if app_role() is distinct from 'manager' then
        return 'not_found';
      end if;
      select ar.id, ar.client_id, ar.kind, ar.status, ar.content, ar.operator_id, ar.org_id, ar.manager_id
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
      if not exists (
        select 1 from companion_devices
          where client_id = a.client_id and status in ('bound', 'active', 'paused')
      ) then
        return 'no_companion';
      end if;
      if p_content is distinct from (a.content ->> 'clientFacing') then
        return 'content_mismatch';
      end if;
      if exists (select 1 from companion_deliveries where artifact_id = a.id) then
        return 'already';
      end if;
      insert into companion_deliveries (client_id, artifact_id, kind, content, sent_by)
        values (a.client_id, a.id, a.kind, p_content, app_user_id());
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        values (a.id, a.operator_id, a.org_id, a.manager_id, app_user_id(), 'companion_synced');
      return 'ok';
    end
    $$;
    revoke all on function sync_artifact_to_companion(uuid, text) from public;
    grant execute on function sync_artifact_to_companion(uuid, text) to ${app};
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
