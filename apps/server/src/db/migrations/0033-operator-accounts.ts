import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M7 第 2 步：协会开通机构和账号（规格 2.4，Q7、Q8、Q9、Q16）。
 *
 * - 运营商管理员在本协会开机构、开健管师和机构管理员（单个或批量），停用、恢复、重发邀请。
 *   协会由会话决定，函数里再查一次调用者账号和协会状态（同第 1 步 admin_require_platform）。
 * - 平台仍然只能开运营商管理员、只给运营商管理员重发邀请（Q16：平台不代办）。
 * - 席位（Q7）：只算待激活和已激活的健管师。开通时锁住协会这一行再数，并发开通不会超卖。
 * - 名下有客户的健管师不能停用（Q8）。能看到客户资料（名下或本机构有客户、或留有服务记录）的
 *   健管师和机构管理员不能重发邀请，这样的机构也不能新开机构管理员。邀请链接交到协会管理员手里，能看客户明细的账号
 *   不经协会管理员之手重置（产品负责人 2026-10-31 确认，红线 1）。
 * 自定义错误码：HB001 席位不足，HB002 有客户。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    alter table organizations add constraint organizations_name_length
      check (char_length(trim(name)) between 1 and 60);
    create unique index organizations_operator_name_key
      on organizations (operator_id, lower(trim(name)));

    alter table admin_audit_log drop constraint admin_audit_log_object_type_check;
    alter table admin_audit_log add constraint admin_audit_log_object_type_check
      check (object_type in ('operator', 'organization', 'user'));
  `.execute(db);

  await sql`
    -- 调用者必须是在用的运营商管理员，所在协会在用；返回协会 id
    create function admin_require_operator() returns uuid
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'operator_admin' or app_user_id() is null
        or app_operator_id() is null
        or not exists (select 1 from users u join operators o on o.id = u.operator_id
          where u.id = app_user_id() and u.role = 'operator_admin' and u.status = 'active'
            and u.operator_id = app_operator_id() and o.status = 'active')
      then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      return app_operator_id();
    end
    $$;

    -- 剩余席位。锁住协会这一行，同一事务里后续的开通不会和别的请求并发超卖。
    -- 用 no key update：开通请求之间互斥，但不挡引用协会的外键检查（租户审查 S2）
    create function admin_seats_left(p_operator uuid) returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_limit int;
    begin
      select seat_limit into v_limit from operators where id = p_operator for no key update;
      return v_limit - (select count(*) from users where operator_id = p_operator
        and role = 'manager' and status in ('pending', 'active'));
    end
    $$;

    -- 健管师名下现在有没有客户（停用前要先转出，Q8）
    create function admin_has_clients(p_user uuid) returns boolean
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select exists (select 1 from clients where manager_id = p_user)
    $$;

    /*
     * 账号能不能看到客户资料：健管师看名下的，机构管理员看本机构的。
     * 客户转出后，对话、解读、随访记录等仍按 manager_id / org_id 留在原账号下（租户审查 B3），
     * 所以不只看 clients：public 下所有带 manager_id（健管师）或 org_id（机构）列的表，
     * 有任何一行就算能看到。按目录查表，以后新加的表自动纳入。
     * 机构那一路先锁住机构行（for update 和插入客户时的外键锁冲突），避免检查后马上有人建客户（租户审查 S1）。
     */
    create function admin_sees_clients(p_role user_role, p_user uuid, p_org uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare t text; v_col text; v_id uuid; v_found boolean;
    begin
      if p_role = 'manager' then
        v_col := 'manager_id'; v_id := p_user;
      elsif p_role = 'org_admin' then
        v_col := 'org_id'; v_id := p_org;
        perform 1 from organizations where id = p_org for update;
      else
        return false;
      end if;
      for t in
        select c.relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          join pg_attribute a on a.attrelid = c.oid and a.attname = v_col and not a.attisdropped
        where c.relkind in ('r', 'p') and c.relname not in ('users', 'organizations')
      loop
        execute format('select exists (select 1 from public.%I where %I = $1)', t, v_col)
          into v_found using v_id;
        if v_found then return true; end if;
      end loop;
      return false;
    end
    $$;
  `.execute(db);

  await sql`
    create function admin_create_organization(p_name text) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_op uuid; v_id uuid;
    begin
      v_op := admin_require_operator();
      insert into organizations (operator_id, name) values (v_op, trim(p_name))
        returning id into v_id;
      perform admin_audit(v_op, 'organization', v_id, 'created', null,
        jsonb_build_object('name', trim(p_name)));
      return v_id;
    end
    $$;

    -- 平台：只开运营商管理员。运营商管理员：只在本协会开健管师、机构管理员，机构必须是本协会的
    create or replace function admin_invite_user(p_role user_role, p_operator uuid, p_org uuid,
      p_email text, p_name text, p_token_hash bytea, p_expires_at timestamptz) returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_id uuid; v_op uuid;
    begin
      perform admin_check_invite_expiry(p_expires_at);
      if char_length(trim(coalesce(p_name, ''))) not between 1 and 40
        or char_length(trim(coalesce(p_email, ''))) not between 3 and 254
      then
        raise exception 'invalid account' using errcode = 'check_violation';
      end if;
      if app_role() = 'operator_admin' then
        v_op := admin_require_operator();
        if p_operator is distinct from v_op then
          raise exception 'operator not found' using errcode = 'P0002';
        end if;
        if p_role not in ('manager', 'org_admin') then
          raise exception 'role not allowed' using errcode = '42501';
        end if;
        if p_role = 'org_admin' and p_org is null then
          raise exception 'org required' using errcode = 'check_violation';
        end if;
        if p_org is not null and not exists
          (select 1 from organizations where id = p_org and operator_id = v_op)
        then
          raise exception 'org not found' using errcode = 'P0002';
        end if;
        if p_role = 'org_admin' and admin_sees_clients(p_role, null, p_org) then
          raise exception 'has clients' using errcode = 'HB002';
        end if;
        if p_role = 'manager' and admin_seats_left(v_op) < 1 then
          raise exception 'seat limit' using errcode = 'HB001';
        end if;
      else
        perform admin_require_platform();
        if p_role <> 'operator_admin' or p_org is not null then
          raise exception 'role not allowed' using errcode = '42501';
        end if;
        if not exists (select 1 from operators where id = p_operator) then
          raise exception 'operator not found' using errcode = 'P0002';
        end if;
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

    /*
     * 批量开通（规格 2.4 第 2 条）：逐行校验，任何一行有错或席位不够都不写入。
     * p_rows：[{row, role, name, email, org_name, token_hash(hex)}]，最多 200 行。
     * p_commit = false 只校验（服务器已发现格式错误时，用来补齐其余行的错误）。
     * 返回 {committed, errors: [{row, code}], seats_left, needed, ids: [{row, id}]}；
     * 写入成功时 seats_left 是扣减之后的。
     * 邮箱被别的协会用了也只报 email_taken，不说是谁的（验收 16）。
     */
    create function admin_import_accounts(p_rows jsonb, p_expires_at timestamptz,
      p_commit boolean) returns jsonb
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_op uuid; r jsonb; v_code text; v_org uuid; v_email text; v_role text;
      v_seats int; v_needed int := 0; v_errors jsonb := '[]'; v_ids jsonb := '[]';
      v_emails text[] := '{}'; v_orgs jsonb := '{}'; v_id uuid;
    begin
      v_op := admin_require_operator();
      perform admin_check_invite_expiry(p_expires_at);
      if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 200 then
        raise exception 'invalid rows' using errcode = 'check_violation';
      end if;
      v_seats := admin_seats_left(v_op);
      for r in select value from jsonb_array_elements(p_rows) order by (value->>'row')::int loop
        v_code := null;
        v_role := r->>'role';
        v_email := lower(trim(coalesce(r->>'email', '')));
        v_org := null;
        if v_role is null or v_role not in ('manager', 'org_admin') then
          v_code := 'role_invalid';
        elsif char_length(trim(coalesce(r->>'name', ''))) not between 1 and 40 then
          v_code := 'name_invalid';
        elsif v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
          or char_length(v_email) > 254
        then
          v_code := 'email_invalid';
        elsif v_email = any (v_emails) then
          v_code := 'email_repeated';
        elsif exists (select 1 from users where lower(email) = v_email) then
          v_code := 'email_taken';
        end if;
        if v_email <> '' then v_emails := v_emails || v_email; end if;
        if v_code is null and nullif(trim(coalesce(r->>'org_name', '')), '') is not null then
          select id into v_org from organizations
            where operator_id = v_op and lower(trim(name)) = lower(trim(r->>'org_name'));
          if v_org is null then v_code := 'org_not_found'; end if;
        end if;
        if v_code is null and v_role = 'org_admin' then
          if v_org is null then
            v_code := 'org_required';
          elsif admin_sees_clients('org_admin', null, v_org) then
            v_code := 'has_clients';
          end if;
        end if;
        if v_role = 'manager' then v_needed := v_needed + 1; end if;
        if v_code is not null then
          v_errors := v_errors || jsonb_build_object('row', (r->>'row')::int, 'code', v_code);
        else
          v_orgs := v_orgs || jsonb_build_object(r->>'row', v_org);
        end if;
      end loop;

      if not p_commit or jsonb_array_length(v_errors) > 0 or v_needed > v_seats then
        return jsonb_build_object('committed', false, 'errors', v_errors,
          'seats_left', v_seats, 'needed', v_needed, 'ids', '[]'::jsonb);
      end if;

      for r in select value from jsonb_array_elements(p_rows) order by (value->>'row')::int loop
        v_org := (v_orgs->>(r->>'row'))::uuid;
        insert into users (email, password_hash, display_name, role, operator_id, org_id, status)
          values (trim(r->>'email'), null, trim(r->>'name'), (r->>'role')::user_role, v_op,
            v_org, 'pending')
          returning id into v_id;
        insert into account_invites (user_id, token_hash, expires_at, created_by)
          values (v_id, decode(r->>'token_hash', 'hex'), p_expires_at, app_user_id());
        perform admin_audit(v_op, 'user', v_id, 'invited', null,
          jsonb_build_object('role', r->>'role', 'email', admin_mask_email(trim(r->>'email')),
            'display_name', trim(r->>'name'), 'org_id', v_org));
        v_ids := v_ids || jsonb_build_object('row', (r->>'row')::int, 'id', v_id);
      end loop;
      return jsonb_build_object('committed', true, 'errors', '[]'::jsonb,
        'seats_left', v_seats - v_needed, 'needed', v_needed, 'ids', v_ids);
    end
    $$;

    -- 重发邀请。平台只给运营商管理员（租户审查 B1）；运营商管理员只给本协会、看不到客户明细的
    -- 健管师和机构管理员（产品负责人 2026-10-31 确认）
    create or replace function admin_reinvite(p_user uuid, p_token_hash bytea,
      p_expires_at timestamptz) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare u users; v_op uuid;
    begin
      perform admin_check_invite_expiry(p_expires_at);
      if app_role() = 'operator_admin' then
        v_op := admin_require_operator();
        select * into u from users where id = p_user and operator_id = v_op
          and role in ('manager', 'org_admin') for update;
      else
        perform admin_require_platform();
        select * into u from users where id = p_user and role = 'operator_admin' for update;
      end if;
      if not found then return false; end if;
      if u.status = 'disabled' then
        raise exception 'account disabled' using errcode = 'check_violation';
      end if;
      if admin_sees_clients(u.role, u.id, u.org_id) then
        raise exception 'has clients' using errcode = 'HB002';
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

    -- 停用、恢复。平台：任何非平台账号；运营商管理员：本协会的健管师和机构管理员。
    -- 名下还有客户的健管师不能停用，先转出（Q8）
    create or replace function admin_set_user_status(p_user uuid, p_disable boolean)
      returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare u users; v_status text; v_op uuid;
    begin
      if app_role() = 'operator_admin' then
        v_op := admin_require_operator();
        select * into u from users where id = p_user and operator_id = v_op
          and role in ('manager', 'org_admin') for update;
      else
        perform admin_require_platform();
        select * into u from users where id = p_user and role <> 'platform_admin' for update;
      end if;
      if not found then return false; end if;
      if p_disable and u.role = 'manager' and admin_has_clients(u.id) then
        raise exception 'has clients' using errcode = 'HB002';
      end if;
      -- 停用的不占席位，恢复健管师要重新占一个（租户审查 B2）
      if not p_disable and u.role = 'manager' and u.status = 'disabled'
        and admin_seats_left(u.operator_id) < 1
      then
        raise exception 'seat limit' using errcode = 'HB001';
      end if;
      v_status := case when p_disable then 'disabled'
        when u.password_hash is null then 'pending' else 'active' end;
      update users set status = v_status where id = p_user;
      if p_disable then
        update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
        update account_invites set expires_at = least(expires_at, now())
          where user_id = p_user and used_at is null;
      end if;
      perform admin_audit(u.operator_id, 'user', p_user,
        case when p_disable then 'disabled' else 'enabled' end,
        jsonb_build_object('status', u.status), jsonb_build_object('status', v_status));
      return true;
    end
    $$;

    -- 本协会每位健管师名下、每个机构里的客户数（只有数字，给“账号”页判断能否停用、重发）
    create function admin_client_counts()
      returns table (manager_id uuid, org_id uuid, n bigint)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_op uuid;
    begin
      v_op := admin_require_operator();
      return query select c.manager_id, c.org_id, count(*) from clients c
        where c.operator_id = v_op group by c.manager_id, c.org_id;
    end
    $$;
  `.execute(db);

  for (const fn of [
    'admin_create_organization(text)',
    'admin_import_accounts(jsonb, timestamptz, boolean)',
    'admin_client_counts()',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to ${app}`.execute(db);
  }
  for (const fn of [
    'admin_require_operator()',
    'admin_seats_left(uuid)',
    'admin_sees_clients(user_role, uuid, uuid)',
    'admin_has_clients(uuid)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
  }
}
