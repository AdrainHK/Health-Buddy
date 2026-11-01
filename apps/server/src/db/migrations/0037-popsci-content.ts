import { POPSCI_DEFAULT_RULES } from '@health-buddy/shared';
import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M8 第 2 步：科普内容的合规规则、检查结果和审核把关（规格 2.1 第 7 条、2.3、3.1，Q2、Q3）。
 *
 * - content_rules：科普合规词表，只追加；第 1 版是 shared 的默认规则。所有后台和健管师都能读
 *   （健管师生成和修改时要用），只有平台经 admin_save_content_rules 写入，并留操作记录。
 * - content_compliance_results：每份科普产物一行，记录按哪一版规则、对哪一版内容（md5）检查、
 *   命中了什么、谁勾选了“已核对”。只给健管师本人（同 artifacts）。
 * - 产物从草稿改为已审核时，数据库再把一次关：要有对应当前内容的检查结果，没有“禁止”类命中，
 *   有“需要人工判断”的项目时已经核对（后端是第一道，这里是第二道）。
 * - 科普产物不属于任何客户：client_id 必须为空。
 * - 套餐新增功能项 content（Q2，推荐 A）：现有套餐一律补 true，保持现在的行为。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  // 套餐功能项 content
  await sql`
    alter table plans drop constraint plans_shape;
    update plans set features = features || '{"content": true}'::jsonb;
    create or replace function plan_shape_ok(p_features jsonb, p_quotas jsonb) returns boolean
      language sql immutable set search_path = pg_catalog, public, pg_temp
    as $$
      select jsonb_typeof(p_features) = 'object' and jsonb_typeof(p_quotas) = 'object'
        and (select array_agg(k order by k) from jsonb_object_keys(p_features) k)
          = array['care', 'companion', 'content', 'experts', 'twin']
        and (select bool_and(jsonb_typeof(v) = 'boolean') from jsonb_each(p_features) e(k, v))
        and (select array_agg(k order by k) from jsonb_object_keys(p_quotas) k)
          = array['companion_devices', 'expert_calls', 'llm_calls', 'report_pages']
        and (select bool_and(jsonb_typeof(v) = 'null'
            or (jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and 10000000
              and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)))
          from jsonb_each(p_quotas) e(k, v))
    $$;
    alter table plans add constraint plans_shape check (plan_shape_ok(features, monthly_quotas));
  `.execute(db);

  // 合规词表
  await sql`
    create table content_rules (
      id uuid primary key default gen_random_uuid(),
      version integer not null unique check (version > 0),
      rules jsonb not null check (jsonb_typeof(rules) = 'array'
        and jsonb_array_length(rules) between 1 and 30),
      -- 不加外键：测试清空账号时不连带清空规则；谁改的以操作记录为准
      created_by uuid,
      created_at timestamptz not null default now()
    );
  `.execute(db);
  await sql`insert into content_rules (version, rules)
    values (1, ${JSON.stringify(POPSCI_DEFAULT_RULES)}::jsonb)`.execute(db);
  await sql`
    create trigger content_rules_append_only before update or delete on content_rules
      for each row execute function append_only();
    alter table content_rules enable row level security;
    create policy content_rules_read on content_rules for select
      using (app_role() in ('manager', 'org_admin', 'operator_admin', 'platform_admin'));
    grant select on content_rules to ${app};

    alter table admin_audit_log drop constraint admin_audit_log_object_type_check;
    alter table admin_audit_log add constraint admin_audit_log_object_type_check
      check (object_type in ('operator', 'organization', 'user', 'plan', 'content_rules'));

    -- 平台保存一版新规则。p_base 是编辑时看到的版本，别人已经存了新版本时拒绝（HB004）
    create function admin_save_content_rules(p_base integer, p_rules jsonb) returns integer
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_latest integer;
      v_id uuid;
    begin
      perform admin_require_platform();
      -- 同时保存时串行
      perform pg_advisory_xact_lock(5002);
      select max(version) into v_latest from content_rules;
      if v_latest is distinct from p_base then
        raise exception 'content rules changed' using errcode = 'HB004';
      end if;
      if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) not between 1 and 30
        or exists (select 1 from jsonb_array_elements(p_rules) g
          where jsonb_typeof(g) <> 'object'
            or not (g ->> 'id') ~ '^[a-z][a-z0-9_]{1,31}$' or (g ->> 'id') like 'builtin\_%'
            or (g ->> 'category') not in ('forbid', 'review')
            or jsonb_typeof(g -> 'terms') <> 'array'
            or jsonb_array_length(g -> 'terms') not between 1 and 200
            or jsonb_typeof(g -> 'negatable') <> 'boolean')
      then
        raise exception 'invalid content rules' using errcode = 'invalid_parameter_value';
      end if;
      insert into content_rules (version, rules, created_by)
        values (v_latest + 1, p_rules, app_user_id()) returning id into v_id;
      perform admin_audit(null, 'content_rules', v_id, 'updated', null,
        jsonb_build_object('version', v_latest + 1));
      return v_latest + 1;
    end
    $$;
    revoke all on function admin_save_content_rules(integer, jsonb) from public;
    grant execute on function admin_save_content_rules(integer, jsonb) to ${app};
  `.execute(db);

  // 检查结果
  await sql`
    alter table artifacts add constraint artifacts_popsci_no_client check (
      kind not in ('popsci_article', 'lecture_deck', 'community_post') or client_id is null);

    create table content_compliance_results (
      artifact_id uuid primary key,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      rules_version integer not null references content_rules (version),
      -- 检查的是哪一版内容：md5(artifacts.structured::text)，由数据库按当前内容填写
      content_md5 text not null,
      hits jsonb not null check (jsonb_typeof(hits) = 'array'),
      checked_at timestamptz not null default now(),
      acked_by uuid references users (id),
      acked_at timestamptz,
      check ((acked_by is null) = (acked_at is null)),
      foreign key (artifact_id, manager_id) references artifacts (id, manager_id) on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    alter table content_compliance_results enable row level security;
    create policy content_compliance_results_manager on content_compliance_results for all
      using (app_role() = 'manager' and manager_id = app_user_id())
      with check (
        app_role() = 'manager' and manager_id = app_user_id()
        and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
        and (acked_by is null or acked_by = app_user_id())
      );
    grant select, insert, update on content_compliance_results to ${app};

    -- 内容指纹和核对：内容指纹一律由数据库按产物当前的结构化内容填写；
    -- 内容或命中项变了就清空核对（规则换了版本但命中项不变时保留）
    create function content_compliance_results_fill() returns trigger language plpgsql as $$
    begin
      select md5(coalesce(a.structured::text, '')) into new.content_md5
        from artifacts a where a.id = new.artifact_id;
      if tg_op = 'UPDATE' and (new.content_md5 is distinct from old.content_md5
          or new.hits is distinct from old.hits)
      then
        new.acked_by := null;
        new.acked_at := null;
        new.checked_at := now();
      end if;
      return new;
    end
    $$;
    create trigger content_compliance_results_fill before insert or update on content_compliance_results
      for each row execute function content_compliance_results_fill();

    -- 科普产物确认前的第二道把关
    create function artifacts_popsci_approve_guard() returns trigger language plpgsql as $$
    declare
      v_result content_compliance_results;
    begin
      if new.status = 'approved' and old.status is distinct from 'approved'
        and new.kind in ('popsci_article', 'lecture_deck', 'community_post')
      then
        select * into v_result from content_compliance_results where artifact_id = new.id;
        if v_result.artifact_id is null
          or v_result.content_md5 is distinct from md5(coalesce(new.structured::text, ''))
          or jsonb_path_exists(v_result.hits, '$[*] ? (@.category == "forbid")')
          or (jsonb_path_exists(v_result.hits, '$[*] ? (@.category == "review")')
            and v_result.acked_at is null)
        then
          raise exception 'popsci content check not passed' using errcode = 'check_violation';
        end if;
      end if;
      return new;
    end
    $$;
    create trigger artifacts_popsci_approve_guard before update on artifacts
      for each row execute function artifacts_popsci_approve_guard();

    alter table artifact_events drop constraint artifact_events_action_check;
    alter table artifact_events add constraint artifact_events_action_check check (
      action in ('created', 'edited', 'approved', 'returned', 'voided', 'copied', 'exported',
                 'companion_synced', 'companion_withdrawn', 'companion_reply_sent',
                 'content_acked')
    );
  `.execute(db);
}
