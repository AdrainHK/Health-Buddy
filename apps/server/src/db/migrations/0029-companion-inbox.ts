import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 伴侣“福宝”第 6 步（6a）：健管师处理转交、预警、待确认的测量，福宝播报回复，后台信息收集
 * （规格 2.4、2.5、2.7、2.8、N10、N13、N14、N18）。
 *
 * - companion_handoffs：健管师直接写回复（人写的，后端过面向客户的检查）或选“已电话联系”、关闭。
 *   状态只能 open → replied → delivered，或 open / replied → closed_by_call / closed；由触发器校验，
 *   回复人、时间由触发器填。delivered 只经设备会话的函数 companion_mark_replies_delivered。
 * - companion_alerts：只能 open → handled，处理方式必填（不能忽略，规格 2.5），处理人、时间由触发器填。
 * - companion_observations：加 polarity（情绪、睡眠类）；后台整理只经 companion_add_observations 写；
 *   待确认的测量只经 companion_observation_resolve 确认（写监测、标孪生重算）或驳回。
 * - 设备读回复只经 companion_pending_replies（已回复、未播报的原文），读不到转交的其他内容。
 * - 健管师可以删除记忆（N10、N11）。
 * - companion_devices.offline_ack_at：健管师在今日跟进里对“设备离线”点了“知道了”（N18），只经函数写。
 */

export const ALERT_RESOLUTIONS_0029 = [
  'called',
  'contacted_family',
  'seen_doctor',
  'other',
] as const;
export const OBSERVATION_CATEGORIES_0029 = [
  'diet',
  'sleep',
  'exercise',
  'mood',
  'adherence',
  'body',
  'life',
  'measurement',
] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  const manager = sql`app_role() = 'manager' and manager_id = app_user_id()`;

  // ---------- 1. 转交：回复、关闭、播报 ----------
  await sql`
    alter table companion_handoffs drop constraint companion_handoffs_status_check;
    alter table companion_handoffs add constraint companion_handoffs_status_check
      check (status in ('open', 'replied', 'delivered', 'closed_by_call', 'closed'));
    alter table companion_handoffs
      add column reply_text text check (char_length(btrim(reply_text)) between 1 and 300),
      add column replied_by uuid references users (id),
      add column replied_at timestamptz,
      add column closed_by uuid references users (id),
      add column closed_at timestamptz,
      add column delivered_at timestamptz,
      add constraint companion_handoffs_reply_check
        check ((status in ('replied', 'delivered')) = (reply_text is not null and replied_at is not null)),
      add constraint companion_handoffs_delivered_check
        check ((status = 'delivered') = (delivered_at is not null));
    create index companion_handoffs_reply_pending_idx on companion_handoffs (client_id)
      where status = 'replied';

    create function companion_handoffs_guard() returns trigger
      language plpgsql set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if hb_is_system(tg_relid) or tg_op = 'INSERT' then
        return new;
      end if;
      -- 健管师只能改状态和回复；原话、类别、客户、来源都不能改
      if new.client_id is distinct from old.client_id or new.question is distinct from old.question
        or new.category is distinct from old.category or new.message_id is distinct from old.message_id
        or new.trigger is distinct from old.trigger or new.created_at is distinct from old.created_at
        or new.delivered_at is distinct from old.delivered_at then
        raise exception 'handoff identity is immutable' using errcode = 'check_violation';
      end if;
      if new.status = 'replied' and old.status = 'open' and new.reply_text is not null then
        new.replied_by := app_user_id();
        new.replied_at := now();
        new.closed_by := null;
        new.closed_at := null;
      elsif new.status in ('closed_by_call', 'closed') and old.status in ('open', 'replied')
        and new.reply_text is not distinct from old.reply_text then
        new.closed_by := app_user_id();
        new.closed_at := now();
        new.replied_by := old.replied_by;
        new.replied_at := old.replied_at;
      else
        raise exception 'invalid handoff transition' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger companion_handoffs_guard before update on companion_handoffs
      for each row execute function companion_handoffs_guard();
    create policy companion_handoffs_manager_update on companion_handoffs for update
      using (${manager}) with check (${manager});
    grant update (status, reply_text, replied_by, replied_at, closed_by, closed_at)
      on companion_handoffs to ${app};
  `.execute(db);

  // ---------- 2. 预警：处理 ----------
  await sql`
    alter table companion_alerts
      add column handled_by uuid references users (id),
      add column handled_at timestamptz,
      add column resolution text check (resolution in (${list(ALERT_RESOLUTIONS_0029)})),
      add column note text check (char_length(note) <= 500),
      add constraint companion_alerts_handled_check
        check ((status = 'handled') = (resolution is not null and handled_at is not null));

    create function companion_alerts_guard() returns trigger
      language plpgsql set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if hb_is_system(tg_relid) or tg_op = 'INSERT' then
        return new;
      end if;
      if new.client_id is distinct from old.client_id or new.category is distinct from old.category
        or new.trigger is distinct from old.trigger or new.message_id is distinct from old.message_id
        or new.reading_id is distinct from old.reading_id
        or new.script_version is distinct from old.script_version
        or new.created_at is distinct from old.created_at then
        raise exception 'alert identity is immutable' using errcode = 'check_violation';
      end if;
      -- 只能处理一次，处理方式必填；不能“忽略”（规格 2.5）
      if old.status <> 'open' or new.status <> 'handled' or new.resolution is null then
        raise exception 'invalid alert transition' using errcode = 'check_violation';
      end if;
      new.handled_by := app_user_id();
      new.handled_at := now();
      return new;
    end
    $$;
    create trigger companion_alerts_guard before update on companion_alerts
      for each row execute function companion_alerts_guard();
    create policy companion_alerts_manager_update on companion_alerts for update
      using (${manager}) with check (${manager});
    grant update (status, resolution, note, handled_by, handled_at) on companion_alerts to ${app};
  `.execute(db);

  // ---------- 3. 收集信息 ----------
  await sql`
    alter table companion_observations
      add column polarity text check (polarity in ('negative', 'neutral', 'positive')),
      add column source_session_id uuid,
      add column resolved_by uuid references users (id),
      add column resolved_at timestamptz,
      add constraint companion_observations_session_fk foreign key (source_session_id, client_id)
        references companion_sessions (id, client_id) on delete set null (source_session_id),
      add constraint companion_observations_polarity_category
        check (polarity is null or category in ('mood', 'sleep'));

    -- 会话结束后的整理写入的收集信息（设备会话调用）：p_items 是
    -- [{category, text, polarity, metric, values}]，测量类有 metric 和 values 时记成待确认
    create function companion_add_observations(p_client uuid, p_session uuid, p_items jsonb)
      returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v jsonb;
      n int := 0;
    begin
      if p_client is distinct from app_client_id() or not companion_device_can_talk() then
        raise exception 'device cannot write' using errcode = '42501';
      end if;
      if not exists (
        select 1 from companion_sessions s where s.id = p_session and s.client_id = p_client
      ) then
        raise exception 'session not found' using errcode = '42501';
      end if;
      if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then
        raise exception 'invalid observations' using errcode = 'check_violation';
      end if;
      for v in select * from jsonb_array_elements(p_items) loop
        insert into companion_observations
          (client_id, category, text, observed_on, polarity, metric, reading_values,
            source_session_id, status)
          values (p_client, v ->> 'category', v ->> 'text', checkin_local_now()::date,
            v ->> 'polarity', v ->> 'metric',
            coalesce((select array_agg(x::numeric) from jsonb_array_elements_text(
              coalesce(v -> 'values', '[]')) x), '{}'),
            p_session,
            case when v ->> 'metric' is not null then 'pending_confirm' else 'info' end);
        n := n + 1;
      end loop;
      return n;
    end
    $$;

    -- 健管师确认（写监测、标孪生重算）或驳回待确认的测量；返回是否写了监测
    create function companion_observation_resolve(p_id uuid, p_confirm boolean) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      o companion_observations;
      v_codes text[];
      v_now timestamptz := now();
    begin
      if app_role() is distinct from 'manager' then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      select * into o from companion_observations
        where id = p_id and manager_id = app_user_id() and status = 'pending_confirm'
        for update;
      if not found then
        raise exception 'observation not found' using errcode = 'P0002';
      end if;
      update companion_observations
        set status = case when p_confirm then 'confirmed' else 'dismissed' end,
          resolved_by = app_user_id(), resolved_at = v_now
        where id = o.id;
      if not p_confirm then
        return false;
      end if;
      v_codes := checkin_metric_codes(o.metric);
      if v_codes is null or cardinality(v_codes) <> cardinality(o.reading_values) then
        raise exception 'observation has no reading' using errcode = 'check_violation';
      end if;
      for i in 1 .. cardinality(v_codes) loop
        insert into monitoring_readings (client_id, metric, value, unit, measured_at, source)
          values (o.client_id, v_codes[i], o.reading_values[i], checkin_metric_unit(v_codes[i]),
            v_now, 'companion');
      end loop;
      insert into twin_compute_state (client_id, operator_id, org_id, manager_id, requested_at)
        select c.id, c.operator_id, c.org_id, c.manager_id, v_now from clients c
          where c.id = o.client_id
        on conflict (client_id) do update set requested_at = excluded.requested_at;
      return true;
    end
    $$;
  `.execute(db);

  // ---------- 4. 福宝播报回复（N13） ----------
  await sql`
    -- 已回复、还没播报的回复原文（最早的在前），给设备会话
    create function companion_pending_replies(p_client uuid)
      returns table (id uuid, reply_text text)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select h.id, h.reply_text from companion_handoffs h
        where h.client_id = p_client and p_client = app_client_id() and companion_device_can_talk()
          and h.status = 'replied'
        order by h.replied_at, h.id
        limit 3
    $$;

    -- 念完后标记已播报；只认这位客户已回复的
    create function companion_mark_replies_delivered(p_client uuid, p_ids uuid[]) returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      n int;
    begin
      if p_client is distinct from app_client_id() or not companion_device_can_talk() then
        raise exception 'device cannot write' using errcode = '42501';
      end if;
      update companion_handoffs set status = 'delivered', delivered_at = now()
        where client_id = p_client and status = 'replied' and id = any(p_ids);
      get diagnostics n = row_count;
      return n;
    end
    $$;
  `.execute(db);

  // ---------- 5. 记忆删除、设备离线“知道了” ----------
  await sql`
    create policy companion_memories_manager_delete on companion_memories for delete
      using (${manager});

    alter table companion_devices add column offline_ack_at timestamptz;
    grant select (offline_ack_at) on companion_devices to ${app};
    -- 健管师对“设备离线”点“知道了”；设备再上线（last_seen_at 更新）后提醒自然消失
    create function companion_offline_ack(p_client uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'manager' then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      update companion_devices set offline_ack_at = now()
        where client_id = p_client and manager_id = app_user_id();
      return found;
    end
    $$;

    revoke all on function companion_add_observations(uuid, uuid, jsonb),
      companion_observation_resolve(uuid, boolean), companion_pending_replies(uuid),
      companion_mark_replies_delivered(uuid, uuid[]), companion_offline_ack(uuid),
      companion_handoffs_guard(), companion_alerts_guard() from public;
    grant execute on function companion_add_observations(uuid, uuid, jsonb),
      companion_observation_resolve(uuid, boolean), companion_pending_replies(uuid),
      companion_mark_replies_delivered(uuid, uuid[]), companion_offline_ack(uuid) to ${app};
  `.execute(db);
}
