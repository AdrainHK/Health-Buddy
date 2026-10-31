import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M7 第 1 步：账号开通基础（规格 2.1、2.4、2.7、6.2）。
 *
 * - operators：管辖区域、席位数、合同起止日期、停用原因。到期只提醒不自动停用（Q5），不加新状态。
 * - users：状态加 pending（待激活）；待激活的账号还没有密码。
 * - account_invites：一次性邀请，只存令牌哈希。和 sessions 一样开行级安全、不建策略，只经函数访问。
 * - admin_audit_log：开通、停用、恢复、改合同、邀请的记录。只能追加：应用角色只有读权限，
 *   写入只由下面的函数完成；平台读全部，运营商管理员读本协会的。
 * - 写操作都是 SECURITY DEFINER 函数：开头校验调用者角色，写审计，停用时撤销会话。
 *   第 1 步只有平台能调用（开通协会和它的运营商管理员）；协会开通健管师在第 2 步放开。
 * 审计记录不放密码、令牌，邮箱只记掩码（红线 2、6）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    alter table operators
      add column region text[] not null default '{}',
      add column seat_limit int not null default 0 check (seat_limit between 0 and 100000),
      add column contract_start date,
      add column contract_end date,
      add column suspended_reason text check (char_length(suspended_reason) <= 500),
      add constraint operators_contract check (
        contract_start is null or contract_end is null or contract_end >= contract_start
      ),
      -- 恢复后不留停用原因（停用时由函数强制写原因）
      add constraint operators_suspended_reason check (
        status = 'suspended' or suspended_reason is null
      );
    create unique index operators_slug_lower_key on operators (lower(slug));

    alter table users drop constraint users_status_check;
    alter table users add constraint users_status_check
      check (status in ('pending', 'active', 'disabled'));
    alter table users alter column password_hash drop not null;
    -- 已激活的账号必须有密码（待激活、没设过密码就被停用的可以没有）
    alter table users add constraint users_password_set
      check (status <> 'active' or password_hash is not null);

    create table account_invites (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id) on delete cascade,
      token_hash bytea not null unique,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_by uuid not null references users (id),
      created_at timestamptz not null default now()
    );
    create index account_invites_user_idx on account_invites (user_id);
    alter table account_invites enable row level security;

    create table admin_audit_log (
      id bigint generated always as identity primary key,
      operator_id uuid references operators (id),
      actor_id uuid references users (id),
      actor_role user_role,
      object_type text not null check (object_type in ('operator', 'user')),
      object_id uuid not null,
      action text not null check (action in ('created', 'updated', 'suspended', 'resumed',
        'invited', 'reinvited', 'activated', 'disabled', 'enabled')),
      before jsonb,
      after jsonb,
      created_at timestamptz not null default now()
    );
    create index admin_audit_log_operator_idx on admin_audit_log (operator_id, created_at desc);
    create index admin_audit_log_created_idx on admin_audit_log (created_at desc);
    alter table admin_audit_log enable row level security;
    create policy admin_audit_log_select on admin_audit_log for select using (
      app_role() = 'platform_admin'
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
    );
    grant select on admin_audit_log to ${app};
  `.execute(db);

  // 内部工具：邮箱掩码、写审计。只给下面的函数用，应用角色不能直接调用
  await sql`
    create function admin_mask_email(p_email text) returns text
      language sql immutable set search_path = pg_catalog, public, pg_temp
    as $$
      -- 用户名不超过 2 个字符时不显示首字母（合规审查 S9）
      select case when char_length(split_part(p_email, '@', 1)) <= 2 then ''
        else left(split_part(p_email, '@', 1), 1) end || '***@' || split_part(p_email, '@', 2)
    $$;

    create function admin_audit(p_operator uuid, p_type text, p_object uuid, p_action text,
      p_before jsonb, p_after jsonb) returns void
      language sql security definer set search_path = pg_catalog, public, pg_temp
    as $$
      insert into admin_audit_log
        (operator_id, actor_id, actor_role, object_type, object_id, action, before, after)
      values (p_operator, app_user_id(), app_role()::user_role, p_type, p_object, p_action,
        p_before, p_after)
    $$;
    revoke all on function admin_audit(uuid, text, uuid, text, jsonb, jsonb) from public;

    -- 会话变量之外再查一次账号本身（租户审查 S2）：必须是在用的平台管理员
    create function admin_require_platform() returns void
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'platform_admin' or app_user_id() is null
        or not exists (select 1 from users where id = app_user_id()
          and role = 'platform_admin' and status = 'active')
      then
        raise exception 'not allowed' using errcode = '42501';
      end if;
    end
    $$;

    -- 邀请有效期必须在将来、且不超过 72 小时（租户审查 S3）
    create function admin_check_invite_expiry(p_expires_at timestamptz) returns void
      language plpgsql stable set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if p_expires_at is null or p_expires_at <= now()
        or p_expires_at > now() + interval '72 hours 1 minute'
      then
        raise exception 'invalid invite expiry' using errcode = 'check_violation';
      end if;
    end
    $$;

    -- 协会的审计快照：只有业务字段
    create function admin_operator_snapshot(o operators) returns jsonb
      language sql immutable set search_path = pg_catalog, public, pg_temp
    as $$
      select jsonb_build_object('name', o.name, 'slug', o.slug, 'region', to_jsonb(o.region),
        'seat_limit', o.seat_limit, 'contract_start', o.contract_start,
        'contract_end', o.contract_end, 'status', o.status, 'suspended_reason', o.suspended_reason)
    $$;
  `.execute(db);

  await sql`
    create function admin_create_operator(p_name text, p_slug text, p_region text[],
      p_seat_limit int, p_contract_start date, p_contract_end date) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare o operators;
    begin
      perform admin_require_platform();
      insert into operators (name, slug, region, seat_limit, contract_start, contract_end)
        values (p_name, p_slug, coalesce(p_region, '{}'), p_seat_limit, p_contract_start,
          p_contract_end)
        returning * into o;
      perform admin_audit(o.id, 'operator', o.id, 'created', null, admin_operator_snapshot(o));
      return o.id;
    end
    $$;

    create function admin_update_operator(p_id uuid, p_name text, p_region text[],
      p_seat_limit int, p_contract_start date, p_contract_end date) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare b operators; a operators;
    begin
      perform admin_require_platform();
      select * into b from operators where id = p_id for update;
      if not found then return false; end if;
      update operators set name = p_name, region = coalesce(p_region, '{}'),
          seat_limit = p_seat_limit, contract_start = p_contract_start,
          contract_end = p_contract_end
        where id = p_id returning * into a;
      perform admin_audit(p_id, 'operator', p_id, 'updated', admin_operator_snapshot(b),
        admin_operator_snapshot(a));
      return true;
    end
    $$;

    -- 停用：必须写原因；该协会所有账号的会话立即作废（auth_resolve_session 也不再放行）
    create function admin_set_operator_status(p_id uuid, p_suspend boolean, p_reason text)
      returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare b operators; a operators;
    begin
      perform admin_require_platform();
      if p_suspend and char_length(trim(coalesce(p_reason, ''))) < 5 then
        raise exception 'reason too short' using errcode = 'check_violation';
      end if;
      select * into b from operators where id = p_id for update;
      if not found then return false; end if;
      -- 状态没变时不写记录（租户审查 S5）
      if (b.status = 'suspended') = p_suspend then
        return true;
      end if;
      update operators set
          status = case when p_suspend then 'suspended' else 'active' end,
          suspended_reason = case when p_suspend then trim(p_reason) end
        where id = p_id returning * into a;
      if p_suspend then
        update sessions s set revoked_at = now()
          from users u where u.id = s.user_id and u.operator_id = p_id and s.revoked_at is null;
      end if;
      perform admin_audit(p_id, 'operator', p_id,
        case when p_suspend then 'suspended' else 'resumed' end,
        admin_operator_snapshot(b), admin_operator_snapshot(a));
      return true;
    end
    $$;

    -- 开通账号并生成邀请。第 1 步只有平台能开，且只能开运营商管理员
    create function admin_invite_user(p_role user_role, p_operator uuid, p_org uuid,
      p_email text, p_name text, p_token_hash bytea, p_expires_at timestamptz) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_id uuid;
    begin
      perform admin_require_platform();
      perform admin_check_invite_expiry(p_expires_at);
      if p_role <> 'operator_admin' or p_org is not null then
        raise exception 'role not allowed' using errcode = '42501';
      end if;
      if not exists (select 1 from operators where id = p_operator) then
        raise exception 'operator not found' using errcode = 'P0002';
      end if;
      insert into users (email, password_hash, display_name, role, operator_id, org_id, status)
        values (trim(p_email), null, trim(p_name), p_role, p_operator, p_org, 'pending')
        returning id into v_id;
      insert into account_invites (user_id, token_hash, expires_at, created_by)
        values (v_id, p_token_hash, p_expires_at, app_user_id());
      perform admin_audit(p_operator, 'user', v_id, 'invited', null,
        jsonb_build_object('role', p_role, 'email', admin_mask_email(trim(p_email)),
          'display_name', trim(p_name), 'org_id', p_org));
      return v_id;
    end
    $$;

    -- 重发邀请（也是找回密码，Q3）：旧邀请和密码作废、会话撤销，账号回到待激活。停用的账号不能重发。
    -- 平台只能给运营商管理员重发：链接返回给调用者，对健管师重发等于让平台冒充健管师看客户明细
    -- （租户审查 B1，红线 1）
    create function admin_reinvite(p_user uuid, p_token_hash bytea, p_expires_at timestamptz)
      returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare u users;
    begin
      perform admin_require_platform();
      perform admin_check_invite_expiry(p_expires_at);
      select * into u from users where id = p_user and role = 'operator_admin' for update;
      if not found then return false; end if;
      if u.status = 'disabled' then
        raise exception 'account disabled' using errcode = 'check_violation';
      end if;
      update account_invites set expires_at = least(expires_at, now())
        where user_id = p_user and used_at is null;
      update users set status = 'pending', password_hash = null where id = p_user;
      update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
      insert into account_invites (user_id, token_hash, expires_at, created_by)
        values (p_user, p_token_hash, p_expires_at, app_user_id());
      perform admin_audit(u.operator_id, 'user', p_user, 'reinvited',
        jsonb_build_object('status', u.status), jsonb_build_object('status', 'pending'));
      return true;
    end
    $$;

    -- 停用、恢复账号。停用时撤销会话；恢复时有密码的回到已激活，没设过密码的回到待激活
    create function admin_set_user_status(p_user uuid, p_disable boolean) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare u users; v_status text;
    begin
      perform admin_require_platform();
      select * into u from users where id = p_user and role <> 'platform_admin' for update;
      if not found then return false; end if;
      v_status := case when p_disable then 'disabled'
        when u.password_hash is null then 'pending' else 'active' end;
      update users set status = v_status where id = p_user;
      if p_disable then
        update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
        -- 未用的邀请一并作废：恢复后不能再用旧链接（租户审查 S1）
        update account_invites set expires_at = least(expires_at, now())
          where user_id = p_user and used_at is null;
      end if;
      perform admin_audit(u.operator_id, 'user', p_user,
        case when p_disable then 'disabled' else 'enabled' end,
        jsonb_build_object('status', u.status), jsonb_build_object('status', v_status));
      return true;
    end
    $$;

    -- 接受邀请（未登录调用）：邀请有效才设置密码、激活，返回账号角色（前端决定去工作台还是后台）；无效返回 null
    create function auth_accept_invite(p_token_hash bytea, p_password_hash text) returns user_role
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare i account_invites; u users;
    begin
      select * into i from account_invites
        where token_hash = p_token_hash and used_at is null and expires_at > now()
        for update;
      if not found then return null; end if;
      select * into u from users where id = i.user_id for update;
      if u.status <> 'pending' then return null; end if;
      -- 协会已停用时不能激活（租户审查 S4）
      if exists (select 1 from operators o where o.id = u.operator_id and o.status <> 'active') then
        return null;
      end if;
      update account_invites set used_at = now() where id = i.id;
      update users set password_hash = p_password_hash, status = 'active' where id = u.id;
      insert into admin_audit_log (operator_id, actor_id, actor_role, object_type, object_id, action)
        values (u.operator_id, u.id, u.role, 'user', u.id, 'activated');
      return u.role;
    end
    $$;
  `.execute(db);

  for (const fn of [
    'admin_create_operator(text, text, text[], int, date, date)',
    'admin_update_operator(uuid, text, text[], int, date, date)',
    'admin_set_operator_status(uuid, boolean, text)',
    'admin_invite_user(user_role, uuid, uuid, text, text, bytea, timestamptz)',
    'admin_reinvite(uuid, bytea, timestamptz)',
    'admin_set_user_status(uuid, boolean)',
    'auth_accept_invite(bytea, text)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to ${app}`.execute(db);
  }
  for (const fn of [
    'admin_mask_email(text)',
    'admin_require_platform()',
    'admin_check_invite_expiry(timestamptz)',
    'admin_operator_snapshot(operators)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
  }
}
