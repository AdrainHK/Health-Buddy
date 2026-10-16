import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M2 统一客户档案（规格 3.1、3.2）：健康史、风险分层历史，
 * 并给已有的体检报告和指标补上租户列。
 *
 * 隔离模型：
 * - 四张表都带 operator_id、org_id、manager_id、client_id，策略直接比较本表的列，
 *   不再用 exists 查 clients 推导。
 * - 复合外键 (client_id, manager_id) → clients on update cascade on delete cascade：
 *   客户转给别的健管师时，档案数据跟着客户走，原健管师随即看不到；客户删除时一起删除。
 * - (manager_id, org_id) → users on update cascade：健管师调机构时 org_id 跟着变。
 * - 客户跨机构转出时，外键只级联 manager_id，所以由触发器从客户行同步 org_id。
 * - 健管师可读写自己客户的档案；机构管理员只读本机构客户的档案（Q14）；运营商和平台没有策略。
 * - 分层历史只能追加（触发器），应用角色也没有 update、delete 权限。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  // 档案数据的租户列一律取自客户行：插入时，以及客户转出（manager_id 级联变化）时。
  // 以所有者身份读取客户，不受行级安全约束；写入的行是否放行仍由调用者的策略决定，
  // 所以给别人的客户写数据时，行会带上别人的租户列，被策略拒绝。
  await sql`
    create function client_record_tenant() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      c record;
    begin
      if tg_op = 'INSERT'
        or new.client_id is distinct from old.client_id
        or new.manager_id is distinct from old.manager_id
      then
        select operator_id, org_id, manager_id into c from clients where id = new.client_id;
        if found then
          new.operator_id := c.operator_id;
          new.org_id := c.org_id;
          new.manager_id := c.manager_id;
        end if;
      end if;
      return new;
    end
    $$;
    revoke all on function client_record_tenant() from public;
  `.execute(db);

  // 已有的报告和指标：补租户列，合成数据按客户回填
  for (const table of ['health_reports', 'report_indicators']) {
    const t = sql.table(table);
    await sql`
      alter table ${t}
        add column operator_id uuid references operators (id),
        add column org_id uuid,
        add column manager_id uuid;
      update ${t} r set operator_id = c.operator_id, org_id = c.org_id, manager_id = c.manager_id
        from clients c where c.id = r.client_id;
      alter table ${t}
        alter column operator_id set not null,
        alter column manager_id set not null,
        add foreign key (client_id, manager_id) references clients (id, manager_id)
          on update cascade on delete cascade,
        add foreign key (manager_id, org_id) references users (id, org_id) on update cascade;
      create index ${sql.id(`${table}_manager_idx`)} on ${t} (manager_id);
      create index ${sql.id(`${table}_org_idx`)} on ${t} (org_id);

      drop policy ${sql.id(`${table}_select`)} on ${t};
      drop policy ${sql.id(`${table}_write`)} on ${t};
    `.execute(db);
  }

  await sql`
    create table client_health_history (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      category text not null check (
        category in ('past_history', 'family_history', 'medication', 'allergy', 'lifestyle')
      ),
      content text not null check (length(content) between 1 and 500),
      recorded_on date,
      created_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index client_health_history_client_idx on client_health_history (client_id, created_at);
    create index client_health_history_manager_idx on client_health_history (manager_id);
    create index client_health_history_org_idx on client_health_history (org_id);

    create table client_risk_tiers (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      tier text not null check (tier in ('high', 'medium', 'low')),
      reason text not null check (length(reason) between 1 and 500),
      set_by uuid not null references users (id),
      set_at timestamptz not null default clock_timestamp(),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    -- 最新一条就是当前分层
    create index client_risk_tiers_client_idx on client_risk_tiers (client_id, set_at desc, id desc);
    create index client_risk_tiers_manager_idx on client_risk_tiers (manager_id);
    create index client_risk_tiers_org_idx on client_risk_tiers (org_id);
  `.execute(db);

  // 行级安全：健管师本人可读写，写入时租户列必须和当前上下文一致；机构管理员只读本机构
  for (const table of [
    'health_reports',
    'report_indicators',
    'client_health_history',
    'client_risk_tiers',
  ]) {
    const t = sql.table(table);
    await sql`
      alter table ${t} enable row level security;
      create policy ${sql.id(`${table}_manager`)} on ${t} for all
        using (app_role() = 'manager' and manager_id = app_user_id())
        with check (
          app_role() = 'manager' and manager_id = app_user_id()
          and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
        );
      create policy ${sql.id(`${table}_org_admin_select`)} on ${t} for select
        using (app_role() = 'org_admin' and org_id = app_org_id());
      create trigger ${sql.id(`${table}_tenant`)} before insert or update on ${t}
        for each row execute function client_record_tenant();
    `.execute(db);
  }

  // 机构管理员看不到已删除的健康史：把它的策略收窄
  await sql`
    drop policy client_health_history_org_admin_select on client_health_history;
    create policy client_health_history_org_admin_select on client_health_history for select
      using (app_role() = 'org_admin' and org_id = app_org_id() and deleted_at is null);
  `.execute(db);

  // 健康史：应用只能以本人名义新增；已删除的条目只读（不能恢复或再改）
  await sql`
    create function client_health_history_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.created_by is distinct from app_user_id() or new.deleted_at is not null then
          raise exception 'history item must be created by the current user'
            using errcode = 'check_violation';
        end if;
        return new;
      end if;
      if old.deleted_at is not null then
        raise exception 'history item is deleted' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger client_health_history_guard before insert or update on client_health_history
      for each row execute function client_health_history_guard();

    -- 分层：应用只能以本人名义、当前时间写入；历史只能追加（系统级联除外，见 append_only）
    create function client_risk_tiers_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.set_by is distinct from app_user_id() then
        raise exception 'risk tier must be set by the current user' using errcode = 'check_violation';
      end if;
      -- 用 clock_timestamp：同一事务里连设两次，先后顺序也确定
      new.set_at := clock_timestamp();
      return new;
    end
    $$;
    create trigger client_risk_tiers_guard before insert on client_risk_tiers
      for each row execute function client_risk_tiers_guard();
    create trigger client_risk_tiers_append_only before update or delete on client_risk_tiers
      for each row execute function append_only();
  `.execute(db);

  // 健康史只开放内容相关的列，租户列和客户不能由应用改；不授予 delete（软删除）
  await sql`
    grant select, insert on client_health_history to ${app};
    grant update (category, content, recorded_on, deleted_at) on client_health_history to ${app};
    grant select, insert on client_risk_tiers to ${app};

    -- 报告和指标同样只开放内容列：0003 授予的整表 update 收回，租户列和客户不能由应用改
    revoke update on health_reports, report_indicators from ${app};
    grant update (report_date, title, source) on health_reports to ${app};
    grant update (code, value, unit) on report_indicators to ${app};
  `.execute(db);

  // 客户的机构或协会变了、但健管师没变（如健管师调机构经外键级联到客户）：
  // 档案数据的租户列跟着客户同步。健管师变了的情况由外键级联和 client_record_tenant 处理，
  // 这里不碰，否则会在级联之前写出“旧健管师 + 新机构”的行。
  // 以所有者身份执行，属于系统操作（hb_is_system），只能追加的分层历史也能同步。
  await sql`
    create function clients_sync_record_tenant() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      update health_reports set operator_id = new.operator_id, org_id = new.org_id
        where client_id = new.id
          and (operator_id is distinct from new.operator_id or org_id is distinct from new.org_id);
      update report_indicators set operator_id = new.operator_id, org_id = new.org_id
        where client_id = new.id
          and (operator_id is distinct from new.operator_id or org_id is distinct from new.org_id);
      update client_health_history set operator_id = new.operator_id, org_id = new.org_id
        where client_id = new.id
          and (operator_id is distinct from new.operator_id or org_id is distinct from new.org_id);
      update client_risk_tiers set operator_id = new.operator_id, org_id = new.org_id
        where client_id = new.id
          and (operator_id is distinct from new.operator_id or org_id is distinct from new.org_id);
      return new;
    end
    $$;
    revoke all on function clients_sync_record_tenant() from public;
    create trigger clients_sync_record_tenant after update of org_id, operator_id on clients
      for each row
      when (new.manager_id = old.manager_id
        and (new.org_id is distinct from old.org_id or new.operator_id is distinct from old.operator_id))
      execute function clients_sync_record_tenant();
  `.execute(db);
}
