import { sql, type Kysely } from 'kysely';

/**
 * 初始结构：五级账号、客户、会话，以及行级安全策略。
 *
 * 隔离模型：
 * - 应用运行时以 hb_app 角色连接，所有表都受行级安全约束。
 * - 每个请求在事务里用 set_config 写入当前用户的租户上下文（app.user_id 等），策略据此放行。
 * - 没有上下文时，所有策略都不放行。
 * - 会话表和密码哈希对 hb_app 不可见，只能通过下面几个 SECURITY DEFINER 函数访问。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create type user_role as enum ('platform_admin', 'operator_admin', 'org_admin', 'manager');

    create table operators (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
      brand_color text check (brand_color ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),
      status text not null default 'active' check (status in ('active', 'suspended')),
      created_at timestamptz not null default now()
    );

    create table organizations (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      name text not null,
      created_at timestamptz not null default now(),
      unique (id, operator_id)
    );

    create table users (
      id uuid primary key default gen_random_uuid(),
      email text not null,
      password_hash text not null,
      display_name text not null,
      role user_role not null,
      operator_id uuid references operators (id),
      org_id uuid,
      status text not null default 'active' check (status in ('active', 'disabled')),
      created_at timestamptz not null default now(),
      last_login_at timestamptz,
      unique (id, operator_id),
      unique (id, org_id),
      -- 机构必须属于同一个运营商
      foreign key (org_id, operator_id) references organizations (id, operator_id),
      -- 每种角色挂在正确的层级上
      constraint users_scope check (
        (role = 'platform_admin' and operator_id is null and org_id is null)
        or (role = 'operator_admin' and operator_id is not null and org_id is null)
        or (role = 'org_admin' and operator_id is not null and org_id is not null)
        or (role = 'manager' and operator_id is not null)
      )
    );
    create unique index users_email_key on users (lower(email));

    create table clients (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      display_name text not null,
      gender text check (gender in ('female', 'male', 'other')),
      birth_year int check (birth_year between 1900 and 2100),
      is_synthetic boolean not null default false,
      created_at timestamptz not null default now(),
      foreign key (org_id, operator_id) references organizations (id, operator_id),
      -- 服务客户的健管师必须属于同一个运营商
      foreign key (manager_id, operator_id) references users (id, operator_id),
      -- 客户所属机构跟着健管师走：健管师调到别的机构时，客户一起转过去，原机构管理员随即看不到
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index clients_manager_idx on clients (manager_id);
    create index clients_org_idx on clients (org_id);

    create table sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id) on delete cascade,
      token_hash bytea not null unique,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz
    );
    create index sessions_user_idx on sessions (user_id);
  `.execute(db);

  // 租户上下文读取函数。没有设置时返回 null，策略因此不放行。
  await sql`
    create function app_user_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
    create function app_role() returns text language sql stable
      as $$ select nullif(current_setting('app.role', true), '') $$;
    create function app_operator_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.operator_id', true), '')::uuid $$;
    create function app_org_id() returns uuid language sql stable
      as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
  `.execute(db);

  await sql`
    alter table operators enable row level security;
    alter table organizations enable row level security;
    alter table users enable row level security;
    alter table clients enable row level security;
    alter table sessions enable row level security;

    create policy operators_select on operators for select using (
      app_role() = 'platform_admin' or id = app_operator_id()
    );

    create policy organizations_select on organizations for select using (
      app_role() = 'platform_admin'
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
      or id = app_org_id()
    );

    create policy users_select on users for select using (
      app_role() = 'platform_admin'
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
      or (app_role() = 'org_admin' and org_id = app_org_id())
      or id = app_user_id()
    );

    -- 客户明细只有服务该客户的健管师和所在机构的管理员能看；运营商和平台默认看不到。
    create policy clients_select on clients for select using (
      (app_role() = 'manager' and manager_id = app_user_id())
      or (app_role() = 'org_admin' and org_id = app_org_id())
    );
    create policy clients_insert on clients for insert with check (
      app_role() = 'manager' and manager_id = app_user_id() and operator_id = app_operator_id()
      and org_id is not distinct from app_org_id()
    );
    create policy clients_update on clients for update
      using (app_role() = 'manager' and manager_id = app_user_id())
      with check (
        app_role() = 'manager' and manager_id = app_user_id() and operator_id = app_operator_id()
        and org_id is not distinct from app_org_id()
      );
    create policy clients_delete on clients for delete using (
      app_role() = 'manager' and manager_id = app_user_id()
    );
    -- sessions 不建任何策略：hb_app 直接查询永远是空的。
  `.execute(db);

  // 认证相关的受控入口。以所有者身份执行，只暴露登录和会话校验需要的最少信息。
  await sql`
    create function auth_find_user(p_email text)
      returns table (id uuid, password_hash text, role user_role, operator_id uuid, org_id uuid, active boolean)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select u.id, u.password_hash, u.role, u.operator_id, u.org_id,
             u.status = 'active' and coalesce(o.status = 'active', true)
      from users u left join operators o on o.id = u.operator_id
      where lower(u.email) = lower(p_email)
    $$;

    create function auth_create_session(p_user_id uuid, p_token_hash bytea, p_expires_at timestamptz)
      returns uuid
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_id uuid;
    begin
      insert into sessions (user_id, token_hash, expires_at)
        values (p_user_id, p_token_hash, p_expires_at) returning id into v_id;
      update users set last_login_at = now() where id = p_user_id;
      return v_id;
    end
    $$;

    create function auth_resolve_session(p_token_hash bytea)
      returns table (session_id uuid, user_id uuid, role user_role, operator_id uuid, org_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      return query
        update sessions s set last_seen_at = now()
        from users u left join operators o on o.id = u.operator_id
        where s.token_hash = p_token_hash
          and s.user_id = u.id
          and s.revoked_at is null
          and s.expires_at > now()
          -- 空闲超过 3 天的会话失效，被盗的 Cookie 不能长期使用
          and s.last_seen_at > now() - interval '3 days'
          and u.status = 'active'
          and coalesce(o.status = 'active', true)
        returning s.id, u.id, u.role, u.operator_id, u.org_id;
    end
    $$;

    create function auth_revoke_session(p_token_hash bytea)
      returns void
      language sql security definer set search_path = pg_catalog, public, pg_temp
    as $$
      update sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
    $$;

    revoke all on function auth_find_user(text) from public;
    revoke all on function auth_create_session(uuid, bytea, timestamptz) from public;
    revoke all on function auth_resolve_session(bytea) from public;
    revoke all on function auth_revoke_session(bytea) from public;
  `.execute(db);

  await sql`
    -- 旧版本 PostgreSQL 默认允许所有人在 public 下建对象，这里统一收回，防止劫持函数解析。
    revoke create on schema public from public;
    grant usage on schema public to hb_app;
    grant select on operators, organizations to hb_app;
    grant select (id, email, display_name, role, operator_id, org_id, status, created_at, last_login_at)
      on users to hb_app;
    grant select, insert, update, delete on clients to hb_app;
    grant execute on function app_user_id(), app_role(), app_operator_id(), app_org_id() to hb_app;
    grant execute on function auth_find_user(text) to hb_app;
    grant execute on function auth_create_session(uuid, bytea, timestamptz) to hb_app;
    grant execute on function auth_resolve_session(bytea) to hb_app;
    grant execute on function auth_revoke_session(bytea) to hb_app;
  `.execute(db);
}
