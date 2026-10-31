import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M7 第 3 步：协会品牌（规格 2.2、2.3、6.1，Q4、Q11、Q16）。
 *
 * - operator_brands：显示名称、登录页欢迎语、Logo（对象存储 key）。主色沿用 operators.brand_color。
 *   同一协会的账号能读本协会的（工作台顶栏、后台），平台读全部；写只经函数。
 * - 只有运营商管理员能改本协会品牌（平台不代改，Q16），协会由会话决定；每次修改写审计。
 * - public_brand：登录页按协会简称读公开字段（未登录），只返回在用协会的名称、主色、欢迎语和 Logo，
 *   不返回协会 id。
 * 禁用词、主色对比度、Logo 格式在服务器检查（规格 2.2，红线 5）；这里只限长度和类型。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    create table operator_brands (
      operator_id uuid primary key references operators (id),
      display_name text check (char_length(display_name) between 1 and 20),
      login_greeting text check (char_length(login_greeting) between 1 and 60),
      logo_object_key text check (logo_object_key ~ '^brands/[0-9a-f]{32}$'),
      logo_content_type text check (logo_content_type in ('image/png', 'image/svg+xml')),
      logo_updated_at timestamptz,
      updated_by uuid references users (id),
      updated_at timestamptz not null default now(),
      constraint operator_brands_logo check (
        (logo_object_key is null) = (logo_content_type is null)
        and (logo_object_key is null) = (logo_updated_at is null)
      )
    );
    alter table operator_brands enable row level security;
    create policy operator_brands_select on operator_brands for select using (
      app_role() = 'platform_admin' or operator_id = app_operator_id()
    );
    grant select on operator_brands to ${app};
  `.execute(db);

  await sql`
    -- 品牌的审计快照：只有业务字段，Logo 只记有没有、什么时候换的
    create function admin_brand_snapshot(p_operator uuid) returns jsonb
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select jsonb_build_object('brand_name', b.display_name, 'brand_color', o.brand_color,
        'login_greeting', b.login_greeting, 'logo', b.logo_updated_at)
      from operators o left join operator_brands b on b.operator_id = o.id
      where o.id = p_operator
    $$;

    create function admin_update_brand(p_display_name text, p_color text, p_greeting text)
      returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_op uuid; v_before jsonb;
    begin
      v_op := admin_require_operator();
      v_before := admin_brand_snapshot(v_op);
      update operators set brand_color = lower(p_color) where id = v_op;
      insert into operator_brands (operator_id, display_name, login_greeting, updated_by)
        values (v_op, nullif(trim(p_display_name), ''), nullif(trim(p_greeting), ''),
          app_user_id())
        on conflict (operator_id) do update set display_name = excluded.display_name,
          login_greeting = excluded.login_greeting, updated_by = excluded.updated_by,
          updated_at = now();
      perform admin_audit(v_op, 'operator', v_op, 'updated', v_before,
        admin_brand_snapshot(v_op));
    end
    $$;

    -- 换 Logo，返回旧的对象 key（服务器随后删除旧文件）；没有旧的返回 null
    create function admin_set_brand_logo(p_key text, p_type text) returns text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare v_op uuid; v_before jsonb; v_old text;
    begin
      v_op := admin_require_operator();
      v_before := admin_brand_snapshot(v_op);
      select logo_object_key into v_old from operator_brands where operator_id = v_op for update;
      insert into operator_brands (operator_id, logo_object_key, logo_content_type,
          logo_updated_at, updated_by)
        values (v_op, p_key, p_type, now(), app_user_id())
        on conflict (operator_id) do update set logo_object_key = excluded.logo_object_key,
          logo_content_type = excluded.logo_content_type, logo_updated_at = now(),
          updated_by = excluded.updated_by, updated_at = now();
      perform admin_audit(v_op, 'operator', v_op, 'updated', v_before,
        admin_brand_snapshot(v_op));
      return v_old;
    end
    $$;

    -- 登录页品牌（未登录调用）：只有在用协会的公开字段
    create function public_brand(p_slug text)
      returns table (name text, brand_color text, login_greeting text, logo_object_key text,
        logo_content_type text, logo_updated_at timestamptz)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select coalesce(b.display_name, o.name), o.brand_color, b.login_greeting,
        b.logo_object_key, b.logo_content_type, b.logo_updated_at
      from operators o left join operator_brands b on b.operator_id = o.id
      where lower(o.slug) = lower(p_slug) and o.status = 'active'
    $$;
  `.execute(db);

  for (const fn of [
    'admin_update_brand(text, text, text)',
    'admin_set_brand_logo(text, text)',
    'public_brand(text)',
  ]) {
    await sql`revoke all on function ${sql.raw(fn)} from public`.execute(db);
    await sql`grant execute on function ${sql.raw(fn)} to ${app}`.execute(db);
  }
  await sql`revoke all on function admin_brand_snapshot(uuid) from public`.execute(db);
}
