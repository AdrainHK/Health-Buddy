import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M2 体检解读、风险分层建议、面谈提纲和多步计划（规格 2.5–2.9、3.2）。
 *
 * - artifacts 加 source_report_id：复合外键 (source_report_id, client_id) → health_reports，
 *   保证产物依据的报告属于产物的客户。客户转出或删除时 client_id 被置空，外键（MATCH SIMPLE）随即不再约束。
 * - artifacts 加 risk_tier_suggestion：AI 的建议分层，生成后不能改（和危急指标快照一样）。
 * - client_risk_tiers 加 source_artifact_id：复合外键 (source_artifact_id, client_id) → artifacts，
 *   保证来源产物属于同一位客户；触发器再要求来源产物是当前健管师已审核的 /体检解读。
 * - 客户转出或删除时，原健管师的产物和客户断开（client_id 置空），产物依据的报告也置空；
 *   分层历史跟着客户走，来源产物的引用随之置空（新健管师看不到原健管师的产物，M1 Q11），
 *   source = 'artifact' 保留。
 * - task_steps 增加步骤类型 read_report、compare_reports 和 label_date（“正在读取报告（日期）”）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table artifacts
      add constraint artifacts_id_client_key unique (id, client_id),
      add column source_report_id uuid,
      add column risk_tier_suggestion jsonb check (
        risk_tier_suggestion is null or (
          jsonb_typeof(risk_tier_suggestion) = 'object'
          and risk_tier_suggestion ->> 'tier' in ('high', 'medium', 'low')
          and jsonb_typeof(risk_tier_suggestion -> 'reason') = 'string'
          and length(risk_tier_suggestion ->> 'reason') between 1 and 500
        )
      ),
      add foreign key (source_report_id, client_id) references health_reports (id, client_id)
        on delete set null (source_report_id);
    create index artifacts_source_report_idx on artifacts (source_report_id);

    -- source 记下这条分层是手动设定还是采用了建议分层；客户转出后来源产物的引用会置空，source 保留
    alter table client_risk_tiers
      add column source text not null default 'manual' check (source in ('manual', 'artifact')),
      add column source_artifact_id uuid,
      add constraint client_risk_tiers_source check (source = 'artifact' or source_artifact_id is null),
      add foreign key (source_artifact_id, client_id) references artifacts (id, client_id)
        on delete set null (source_artifact_id);
    create index client_risk_tiers_source_idx on client_risk_tiers (source_artifact_id);

    alter table task_steps
      drop constraint task_steps_kind_check,
      add constraint task_steps_kind_check check (
        kind in ('read_client', 'read_report', 'compare_reports', 'detect_critical', 'run_skill', 'answer')
      ),
      -- 只存 YYYY-MM-DD 文本，不经过时区换算
      add column label_date text check (label_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  `.execute(db);
  // 读完报告才知道用的是哪一天的报告，步骤完成时写上日期（规格 2.6）
  await sql`grant update (label_date) on task_steps to ${sql.id(APP_DB_ROLE)}`.execute(db);

  // 产物依据的报告和建议分层：插入时报告必须有客户可对；之后应用不能改（系统级联置空除外）
  await sql`
    create function artifacts_source_guard() returns trigger language plpgsql as $$
    begin
      if tg_op = 'INSERT' then
        -- 复合外键在 client_id 为空时不检查，这里补上：没有客户就不能引用报告
        if new.source_report_id is not null and new.client_id is null then
          raise exception 'artifact report needs a client' using errcode = 'check_violation';
        end if;
        if new.risk_tier_suggestion is not null and new.kind <> 'report_interpretation' then
          raise exception 'only interpretations suggest a risk tier' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      if new.risk_tier_suggestion is distinct from old.risk_tier_suggestion
        or (new.source_report_id is distinct from old.source_report_id
            and (not hb_is_system(tg_relid) or new.source_report_id is not null))
      then
        raise exception 'artifact source is immutable' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger artifacts_source_guard before insert or update on artifacts
      for each row execute function artifacts_source_guard();
  `.execute(db);

  // 0004 的产物状态机：已审核、已退回、已作废的产物也允许系统把依据的报告置空
  // （客户转出或删除时由 detach_client_work 置空，报告删除时由外键置空），其余照旧
  await sql`
    create or replace function artifacts_guard() returns trigger language plpgsql as $$
    declare
      is_app boolean := not hb_is_system(tg_relid);
    begin
      if tg_op = 'INSERT' then
        if new.status <> 'draft' then
          raise exception 'artifact must be inserted as draft' using errcode = 'check_violation';
        end if;
        if is_app and task_detached(new.task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        -- 外键在 client_id 为空时不检查，这里补上：产物的客户必须和任务当前的客户一致
        if new.client_id is distinct from (select t.client_id from tasks t where t.id = new.task_id) then
          raise exception 'artifact client must match its task' using errcode = 'check_violation';
        end if;
        if new.parent_id is not null and new.lineage_id is distinct from
          (select a.lineage_id from artifacts a where a.id = new.parent_id)
        then
          raise exception 'artifact version must stay in its lineage' using errcode = 'check_violation';
        end if;
        return new;
      end if;

      if old.status <> 'draft' then
        -- 非草稿行只允许系统把客户和依据的报告置空（客户转出或删除、报告删除）和跟随健管师调机构
        if is_app
          or (to_jsonb(new) - 'client_id' - 'org_id' - 'updated_at' - 'source_report_id')
             <> (to_jsonb(old) - 'client_id' - 'org_id' - 'updated_at' - 'source_report_id')
          or (new.client_id is distinct from old.client_id and new.client_id is not null)
          or (new.source_report_id is distinct from old.source_report_id
              and new.source_report_id is not null)
        then
          raise exception 'artifact is no longer a draft' using errcode = 'check_violation';
        end if;
        return new;
      end if;

      if new.id <> old.id or new.task_id <> old.task_id or new.manager_id <> old.manager_id
        or new.operator_id <> old.operator_id or new.skill_id <> old.skill_id
        or new.kind <> old.kind or new.lineage_id <> old.lineage_id
        or new.version <> old.version or new.parent_id is distinct from old.parent_id
        or new.created_at <> old.created_at
        or new.critical_flags <> old.critical_flags
      then
        raise exception 'artifact identity is immutable' using errcode = 'check_violation';
      end if;
      if is_app then
        if task_detached(old.task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        if new.client_id is distinct from old.client_id then
          raise exception 'artifact client is immutable' using errcode = 'check_violation';
        end if;
        if new.status = 'voided' then
          raise exception 'only the system can void a draft' using errcode = 'check_violation';
        end if;
      end if;
      if new.status <> 'draft' and new.content <> old.content then
        raise exception 'content and status cannot change together' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
  `.execute(db);

  // 分层：应用只能以本人名义、当前时间写入；来源产物必须是当前健管师已审核的 /体检解读。
  // 以调用者身份查产物（受行级安全约束），看不到的产物按不存在处理。
  await sql`
    create or replace function client_risk_tiers_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.set_by is distinct from app_user_id() then
        raise exception 'risk tier must be set by the current user' using errcode = 'check_violation';
      end if;
      if (new.source = 'artifact') <> (new.source_artifact_id is not null) then
        raise exception 'adopted risk tier needs its source artifact' using errcode = 'check_violation';
      end if;
      if new.source_artifact_id is not null and not exists (
        select 1 from artifacts a
        where a.id = new.source_artifact_id
          and a.client_id = new.client_id
          and a.kind = 'report_interpretation'
          and a.status = 'approved'
          and a.risk_tier_suggestion is not null
      ) then
        raise exception 'risk tier source must be an approved interpretation'
          using errcode = 'check_violation';
      end if;
      new.set_at := clock_timestamp();
      return new;
    end
    $$;
  `.execute(db);

  // 客户转出或删除：沿用 0009，先锁任务（0007 的加锁顺序，0009 改写时漏掉了，这里补回），
  // 并在产物和客户断开之前，把分层历史里对这些产物的引用置空
  await sql`
    create or replace function detach_client_work(p_client_id uuid, p_reason text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      perform 1 from tasks t where t.client_id = p_client_id order by t.id for update;

      with voided as (
        update artifacts set status = 'voided'
          where status = 'draft'
            and (client_id = p_client_id
                 or task_id in (select t.id from tasks t where t.client_id = p_client_id))
          returning id, operator_id, org_id, manager_id
      )
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        select id, operator_id, org_id, manager_id, null, 'voided' from voided;

      update client_risk_tiers set source_artifact_id = null
        where client_id = p_client_id and source_artifact_id is not null;

      -- 原健管师的产物不再指向这位客户的报告（报告跟着客户走）
      update artifacts set source_report_id = null
        where source_report_id is not null
          and (client_id = p_client_id
               or task_id in (select t.id from tasks t where t.client_id = p_client_id));

      update task_messages set client_refs = '{}', report_refs = '{}'
        where task_id in (select t.id from tasks t where t.client_id = p_client_id);

      update tasks set
          client_id = null,
          detached_reason = p_reason,
          archived_at = coalesce(archived_at, now()),
          updated_at = now()
        where client_id = p_client_id;
    end
    $$;
    revoke all on function detach_client_work(uuid, text) from public;
  `.execute(db);
}
