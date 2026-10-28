import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 伴侣“福宝”第 3 步（规格 3.1、3.2、3.4）：设备认证和语音通道的计量。
 *
 * 固件基于开源方案 xiaozhi-esp32（N1），设备认证用它的激活 v2：出厂时厂商把序列号和 HMAC 密钥
 * 烧进 eFuse，设备开机请求配置接口，服务器给一个随机挑战，设备用密钥算 HMAC-SHA256 回传。
 * - 服务器要验证 HMAC 就要拿到密钥本身，所以 companion_devices 加 secret_encrypted：
 *   密钥用 COMPANION_DEVICE_KEY（AES-256-GCM，不进数据库）加密后存放。应用角色只能写入、不能读，
 *   读只经 companion_device_auth_lookup（只在没有租户上下文的连接上可用）。
 * - companion_device_tokens：设备令牌。配置接口发出时是待验证，HMAC 验证通过后才可用；
 *   有效期 30 天；只存 SHA-256。应用角色对这张表没有任何权限，只经下面的函数。
 *   设备解绑、再绑给别人后，绑定之前发的令牌一律无效（connect 时比较 bound_at）。
 * - companion_device_settings()：设备会话读当前客户的称呼、语速、音量（设备角色对 clients 没有策略）。
 * - llm_usage：伴侣的语音识别、合成和对话由设备发起，没有用户。加 device_id，user_id 改为可空，
 *   二者恰好一个。设备的计量行对运营商和平台逐条不可见（Q29），按日汇总在后续步骤提供；
 *   写入只经 record_companion_llm_usage，协会从设备行取，不信任调用方。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  // ---------- 1. 设备密钥（加密存放） ----------
  await sql`
    alter table companion_devices
      add column secret_encrypted bytea check (octet_length(secret_encrypted) between 45 and 200);
    grant insert (secret_encrypted) on companion_devices to ${app};
  `.execute(db);

  // ---------- 2. 设备令牌 ----------
  await sql`
    create table companion_device_tokens (
      id uuid primary key default gen_random_uuid(),
      device_id uuid not null references companion_devices (id) on delete cascade,
      token_hash bytea not null unique check (octet_length(token_hash) = 32),
      challenge text not null check (challenge ~ '^[0-9a-f]{64}$'),
      created_at timestamptz not null default now(),
      activated_at timestamptz,
      expires_at timestamptz not null,
      revoked_at timestamptz
    );
    create index companion_device_tokens_device_idx on companion_device_tokens (device_id, created_at desc);
    alter table companion_device_tokens enable row level security;
    revoke all on companion_device_tokens from ${app};
  `.execute(db);

  // ---------- 3. 设备认证函数：只在没有租户上下文的连接上可用 ----------
  await sql`
    -- 配置接口：按序列号取设备状态和加密的密钥。不返回租户列和客户
    create function companion_device_auth_lookup(p_serial text)
      returns table (id uuid, status text, secret_encrypted bytea)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null then
        raise exception 'device auth only without tenant context' using errcode = '42501';
      end if;
      return query select d.id, d.status, d.secret_encrypted
        from companion_devices d where d.serial_no = p_serial;
    end
    $$;

    -- 发一个待验证的令牌。顺带清理这台设备过期、作废和超时未验证的令牌，待验证的最多留 5 个
    create function companion_device_token_issue(
      p_device_id uuid, p_token_hash bytea, p_challenge text, p_ttl_seconds int
    ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null then
        raise exception 'device auth only without tenant context' using errcode = '42501';
      end if;
      if p_ttl_seconds not between 60 and 60 * 60 * 24 * 90 then
        raise exception 'bad token ttl' using errcode = '22023';
      end if;
      if not exists (
        select 1 from companion_devices
          where id = p_device_id and status in ('bound', 'active', 'paused', 'revoked')
      ) then
        return false;
      end if;
      delete from companion_device_tokens
        where device_id = p_device_id
          and (expires_at <= now() or revoked_at is not null
            or (activated_at is null and created_at < now() - interval '10 minutes'));
      delete from companion_device_tokens
        where id in (
          select id from companion_device_tokens
            where device_id = p_device_id and activated_at is null
            order by created_at desc offset 4
        );
      insert into companion_device_tokens (device_id, token_hash, challenge, expires_at)
        values (p_device_id, p_token_hash, p_challenge, now() + make_interval(secs => p_ttl_seconds));
      return true;
    end
    $$;

    -- HMAC 验证通过后启用这次挑战对应的令牌（10 分钟内），这台设备其他已启用的令牌作废；
    -- 顺带记下设备上报的固件版本
    create function companion_device_token_activate(
      p_device_id uuid, p_challenge text, p_firmware text
    ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_id uuid;
    begin
      if app_role() is not null then
        raise exception 'device auth only without tenant context' using errcode = '42501';
      end if;
      select t.id into v_id from companion_device_tokens t
        join companion_devices d on d.id = t.device_id
        where t.device_id = p_device_id and t.challenge = p_challenge
          and t.activated_at is null and t.revoked_at is null
          and t.created_at >= now() - interval '10 minutes' and t.expires_at > now()
          and d.status in ('bound', 'active', 'paused', 'revoked')
        order by t.created_at desc limit 1
        for update of t;
      if v_id is null then
        return false;
      end if;
      update companion_device_tokens set revoked_at = now()
        where device_id = p_device_id and id <> v_id and activated_at is not null and revoked_at is null;
      update companion_device_tokens set activated_at = now() where id = v_id;
      if p_firmware ~ '^[A-Za-z0-9._+-]{1,64}$' then
        update companion_devices set firmware_version = p_firmware where id = p_device_id;
      end if;
      return true;
    end
    $$;

    -- 语音通道连接：按令牌哈希找设备。令牌须已启用、未作废、未过期、在设备这次绑定之后发出。
    -- 记录最后在线时间；第一次连接时 bound → active（规格 2.1 第 4 步），first_connection 为真
    create function companion_device_connect(p_token_hash bytea)
      returns table (device_id uuid, status text, first_connection boolean)
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_device uuid;
      v_status text;
      v_first boolean := false;
    begin
      if app_role() is not null then
        raise exception 'device auth only without tenant context' using errcode = '42501';
      end if;
      select d.id, d.status into v_device, v_status
        from companion_device_tokens t
        join companion_devices d on d.id = t.device_id
        where t.token_hash = p_token_hash
          and t.activated_at is not null and t.revoked_at is null and t.expires_at > now()
          and d.status in ('bound', 'active', 'paused', 'revoked')
          and d.bound_at is not null and t.created_at >= d.bound_at
        for update of d;
      if v_device is null then
        return;
      end if;
      if v_status = 'bound' then
        v_status := 'active';
        v_first := true;
      end if;
      update companion_devices
        set status = v_status,
            activated_at = case when v_first then now() else activated_at end,
            last_seen_at = now()
        where id = v_device;
      return query select v_device, v_status, v_first;
    end
    $$;

    -- 会话进行中刷新最后在线时间（在线状态按 2 分钟窗口判断）
    create function companion_device_seen(p_device_id uuid) returns void
      language sql security definer set search_path = pg_catalog, public, pg_temp
    as $$
      update companion_devices set last_seen_at = now()
        where id = p_device_id and app_role() is null
          and status in ('active', 'paused', 'revoked');
    $$;

    revoke all on function companion_device_auth_lookup(text) from public;
    revoke all on function companion_device_token_issue(uuid, bytea, text, int) from public;
    revoke all on function companion_device_token_activate(uuid, text, text) from public;
    revoke all on function companion_device_connect(bytea) from public;
    revoke all on function companion_device_seen(uuid) from public;
    grant execute on function companion_device_auth_lookup(text) to ${app};
    grant execute on function companion_device_token_issue(uuid, bytea, text, int) to ${app};
    grant execute on function companion_device_token_activate(uuid, text, text) to ${app};
    grant execute on function companion_device_connect(bytea) to ${app};
    grant execute on function companion_device_seen(uuid) to ${app};
  `.execute(db);

  // ---------- 4. 设备会话读伴侣设置（Q7、N17） ----------
  await sql`
    -- 设备角色对 clients 没有策略；只经这个函数读当前绑定客户的伴侣设置，不含姓名等其他列
    create function companion_device_settings()
      returns table (name_for_client text, voice_speed text, volume text)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select c.companion_name_for_client, c.companion_voice_speed, c.companion_volume
        from clients c where c.id = app_client_id()
    $$;
    revoke all on function companion_device_settings() from public;
    grant execute on function companion_device_settings() to ${app};
  `.execute(db);

  // ---------- 5. 伴侣调用的计量（Q29） ----------
  await sql`
    alter table llm_usage
      alter column user_id drop not null,
      add column device_id uuid references companion_devices (id),
      add constraint llm_usage_one_caller check (num_nonnulls(user_id, device_id) = 1);
    create index llm_usage_device_time_idx on llm_usage (device_id, created_at) where device_id is not null;

    drop policy llm_usage_select on llm_usage;
    create policy llm_usage_select on llm_usage for select using (
      (app_role() = 'platform_admin' and device_id is null)
      -- 路由和汇总（expert_routing、expert_synthesis）的计量行没有 expert_id，同样能看出谁在什么时候请了专家，一并排除
      or (
        app_role() = 'operator_admin'
        and operator_id = app_operator_id()
        and expert_id is null
        and route not like 'expert%'
        and device_id is null
      )
      or user_id = app_user_id()
    );

    create function record_companion_llm_usage(
      p_device_id uuid, p_route text, p_provider text, p_model text,
      p_input_tokens int, p_output_tokens int, p_cost_usd numeric, p_duration_ms int,
      p_outcome text, p_error_type text
    ) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null then
        raise exception 'companion usage only without tenant context' using errcode = '42501';
      end if;
      if p_route not in ('companion', 'speech_to_text', 'text_to_speech') then
        raise exception 'not a companion route' using errcode = '22023';
      end if;
      insert into llm_usage (operator_id, user_id, device_id, route, provider, model, input_tokens,
          output_tokens, cost_usd, duration_ms, outcome, error_type)
        select d.operator_id, null, d.id, p_route, p_provider, p_model, p_input_tokens,
          p_output_tokens, p_cost_usd, p_duration_ms, p_outcome, p_error_type
        from companion_devices d where d.id = p_device_id;
    end
    $$;
    revoke all on function record_companion_llm_usage(uuid, text, text, text, int, int, numeric, int, text, text) from public;
    grant execute on function record_companion_llm_usage(uuid, text, text, text, int, int, numeric, int, text, text) to ${app};
  `.execute(db);
}
