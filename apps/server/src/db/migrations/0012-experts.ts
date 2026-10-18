import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M3 专家智能体中心（规格 6.1、6.2）。
 *
 * 隔离模型和 M1 工作台一致：
 * - expert_consultations、expert_calls、expert_feedback 只对健管师本人开放；机构管理员、运营商、
 *   平台管理员对这些表都没有策略（Q10）。复合外键保证子表和任务属于同一个健管师；
 *   (manager_id, org_id) 跟着健管师调机构。
 * - 专家调用的 client_id 通过复合外键跟着任务走：客户转出或删除时，detach_client_work 把任务的
 *   client_id 置空，级联到调用记录（规格 6.1：专家调用记录跟着任务走，不跟着客户走）。
 * - 专家意见是 AI 的原始输出，写入后不可修改：调用结束后只允许状态从 running 改为终态一次（触发器）。
 * - expert_availability 是平台级的上下架开关：平台管理员可读写，其他角色只读；每次暂停、恢复由
 *   触发器写一条记录，只有平台管理员能看（Q11）。
 * - llm_usage 加 expert_id，不加客户 id 和任务 id（规格 3.7）。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table tasks
      add column expert_id text check (expert_id ~ '^[a-z][a-z0-9-]{1,63}$');

    alter table task_messages
      add constraint task_messages_id_task_key unique (id, task_id),
      add column expert_refs text[] not null default '{}' check (
        cardinality(expert_refs) <= 3
        and array_to_string(expert_refs, ',') ~ '^([a-z][a-z0-9-]{1,63}(,|$))*$'
      ),
      add column excluded_experts text[] not null default '{}' check (
        cardinality(excluded_experts) <= 20
        and array_to_string(excluded_experts, ',') ~ '^([a-z][a-z0-9-]{1,63}(,|$))*$'
      );

    alter table task_steps
      drop constraint task_steps_kind_check,
      add constraint task_steps_kind_check check (
        kind in (
          'read_client', 'read_report', 'compare_reports', 'detect_critical', 'run_skill', 'answer',
          'route_experts', 'consult_experts', 'consult_expert', 'synthesize_experts'
        )
      ),
      add column expert_ids text[] not null default '{}' check (cardinality(expert_ids) <= 10);

    alter table llm_usage
      add column expert_id text check (expert_id ~ '^[a-z][a-z0-9-]{1,63}$');

    -- 运营商原来能读本协会的全部计量行（含 user_id）。专家调用的计量行带 expert_id，
    -- 能看出哪位健管师在什么时间请了哪位专家；运营商不直接读这些行，专家统计以后走不带健管师的汇总
    -- （租户隔离审查）。平台管理员和本人照旧
    drop policy llm_usage_select on llm_usage;
    create policy llm_usage_select on llm_usage for select using (
      app_role() = 'platform_admin'
      or (app_role() = 'operator_admin' and operator_id = app_operator_id() and expert_id is null)
      or user_id = app_user_id()
    );

    create table expert_consultations (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      task_id uuid not null,
      message_id uuid not null,
      client_id uuid,
      report_id uuid,
      trigger text not null check (trigger in ('expert_center', 'mention', 'skill_auto', 'plan')),
      routing jsonb not null check (jsonb_typeof(routing) = 'object'),
      status text not null check (status in ('running', 'done', 'partial', 'failed', 'stopped')),
      synthesis jsonb check (synthesis is null or jsonb_typeof(synthesis) = 'object'),
      synthesis_status text check (synthesis_status in ('skipped', 'done', 'failed')),
      reused_from uuid,
      created_at timestamptz not null default now(),
      finished_at timestamptz,
      unique (id, manager_id),
      unique (id, task_id),
      foreign key (manager_id, operator_id) references users (id, operator_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      foreign key (task_id, manager_id) references tasks (id, manager_id),
      -- 调用的客户和任务一致；任务断开客户时级联置空（规格 6.1）
      foreign key (task_id, client_id, manager_id) references tasks (id, client_id, manager_id)
        on update cascade,
      foreign key (message_id, task_id) references task_messages (id, task_id),
      -- 依据的报告属于调用的客户；报告删除时置空
      foreign key (report_id, client_id) references health_reports (id, client_id)
        on delete set null (report_id),
      foreign key (reused_from, manager_id) references expert_consultations (id, manager_id),
      constraint expert_consultations_finished check ((status = 'running') = (finished_at is null))
    );
    create index expert_consultations_task_idx on expert_consultations (task_id, created_at);
    create index expert_consultations_report_idx on expert_consultations (report_id);

    create table expert_calls (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      consultation_id uuid not null,
      expert_id text not null check (expert_id ~ '^[a-z][a-z0-9-]{1,63}$'),
      expert_version text not null check (expert_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'),
      sources_version text not null check (sources_version ~ '^[0-9a-f]{12}$'),
      selected_reason text not null check (selected_reason in ('manager', 'rule', 'model')),
      status text not null check (status in ('running', 'done', 'failed', 'timeout', 'refused', 'stopped')),
      failure_category text check (
        failure_category in ('timeout', 'refused', 'invalid_output', 'provider_error')
      ),
      opinion jsonb check (opinion is null or jsonb_typeof(opinion) = 'object'),
      removed_findings int not null default 0 check (removed_findings >= 0),
      provider text check (provider in ('openai', 'anthropic')),
      model text,
      input_tokens int not null default 0 check (input_tokens >= 0),
      output_tokens int not null default 0 check (output_tokens >= 0),
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      unique (id, manager_id),
      unique (consultation_id, expert_id),
      foreign key (consultation_id, manager_id) references expert_consultations (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint expert_calls_opinion check ((status = 'done') = (opinion is not null)),
      constraint expert_calls_finished check ((status = 'running') = (finished_at is null))
    );
    create index expert_calls_consultation_idx on expert_calls (consultation_id);
    -- 每日用量上限按健管师和开始时间统计（Q12）
    create index expert_calls_manager_day_idx on expert_calls (manager_id, started_at);

    create table expert_feedback (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      expert_call_id uuid not null,
      rating text not null check (rating in ('useful', 'not_useful')),
      reason text check (reason in ('inaccurate', 'too_general', 'out_of_scope', 'bad_citation', 'other')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (expert_call_id, manager_id),
      foreign key (expert_call_id, manager_id) references expert_calls (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint expert_feedback_reason check (rating = 'not_useful' or reason is null)
    );

    -- 产物用到的专家调用：必须属于同一任务
    alter table artifacts
      add column consultation_id uuid,
      -- 专家意见里有疑似急症信号（合规审查第 2 条）：审核栏醒目提示，专业版最前面有提示
      add column emergency_signal boolean not null default false,
      add foreign key (consultation_id, task_id) references expert_consultations (id, task_id);

    create table expert_availability (
      expert_id text primary key check (expert_id ~ '^[a-z][a-z0-9-]{1,63}$'),
      enabled boolean not null,
      updated_by uuid not null references users (id),
      updated_at timestamptz not null default now()
    );

    create table expert_availability_events (
      id uuid primary key default gen_random_uuid(),
      expert_id text not null,
      actor_id uuid references users (id),
      action text not null check (action in ('paused', 'resumed')),
      created_at timestamptz not null default now()
    );
  `.execute(db);

  // 行级安全：明细只放行健管师本人；写入时租户字段必须和当前上下文一致
  for (const table of ['expert_consultations', 'expert_calls', 'expert_feedback']) {
    await sql`
      alter table ${sql.table(table)} enable row level security;
      create policy ${sql.id(`${table}_manager`)} on ${sql.table(table)} for all
        using (app_role() = 'manager' and manager_id = app_user_id())
        with check (
          app_role() = 'manager' and manager_id = app_user_id()
          and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
        );
    `.execute(db);
  }

  await sql`
    alter table expert_availability enable row level security;
    -- 任何登录账号都能读（专家库要知道哪些专家被暂停）；只有平台管理员能写
    create policy expert_availability_select on expert_availability for select
      using (app_user_id() is not null);
    create policy expert_availability_write on expert_availability for all
      using (app_role() = 'platform_admin')
      with check (app_role() = 'platform_admin' and updated_by = app_user_id());

    alter table expert_availability_events enable row level security;
    create policy expert_availability_events_select on expert_availability_events for select
      using (app_role() = 'platform_admin');
  `.execute(db);

  await sql`
    -- 专家调用：插入时只能是进行中，任务不能是只读，客户和任务一致，消息属于任务
    create function expert_consultations_guard() returns trigger language plpgsql as $$
    declare
      is_app boolean := not hb_is_system(tg_relid);
    begin
      if tg_op = 'INSERT' then
        if new.status <> 'running' or new.synthesis is not null or new.synthesis_status is not null then
          raise exception 'consultation must be inserted as running' using errcode = 'check_violation';
        end if;
        if is_app and task_detached(new.task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        -- 复合外键在 client_id 为空时不检查，这里补上
        if new.client_id is distinct from (select t.client_id from tasks t where t.id = new.task_id) then
          raise exception 'consultation client must match its task' using errcode = 'check_violation';
        end if;
        if new.report_id is not null and new.client_id is null then
          raise exception 'consultation report needs a client' using errcode = 'check_violation';
        end if;
        new.created_at := now();
        return new;
      end if;
      if not is_app then
        -- 系统只做级联：客户置空、跟随健管师调机构、报告删除时置空
        if (to_jsonb(new) - 'client_id' - 'org_id' - 'report_id')
           <> (to_jsonb(old) - 'client_id' - 'org_id' - 'report_id')
          or (new.client_id is distinct from old.client_id and new.client_id is not null)
          or (new.report_id is distinct from old.report_id and new.report_id is not null)
        then
          raise exception 'consultation is immutable' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      -- 应用：只允许 running 改为终态一次，同时写汇总和结束时间
      if old.status <> 'running' or new.status = 'running'
        or (to_jsonb(new) - 'status' - 'synthesis' - 'synthesis_status' - 'finished_at')
           <> (to_jsonb(old) - 'status' - 'synthesis' - 'synthesis_status' - 'finished_at')
      then
        raise exception 'consultation is immutable' using errcode = 'check_violation';
      end if;
      -- 任务已只读（客户转出）时只能结束，不能再写汇总
      if task_detached(old.task_id) and new.synthesis is not null then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      new.finished_at := now();
      return new;
    end
    $$;
    create trigger expert_consultations_guard before insert or update on expert_consultations
      for each row execute function expert_consultations_guard();

    create function expert_calls_guard() returns trigger language plpgsql as $$
    declare
      is_app boolean := not hb_is_system(tg_relid);
      v_task_id uuid;
      v_status text;
    begin
      select c.task_id, c.status into v_task_id, v_status
        from expert_consultations c where c.id = coalesce(new.consultation_id, old.consultation_id);
      if tg_op = 'INSERT' then
        if new.status <> 'running' or new.opinion is not null or new.finished_at is not null then
          raise exception 'expert call must be inserted as running' using errcode = 'check_violation';
        end if;
        if v_status is distinct from 'running' then
          raise exception 'consultation is finished' using errcode = 'check_violation';
        end if;
        if is_app and task_detached(v_task_id) then
          raise exception 'task is read-only' using errcode = 'check_violation';
        end if;
        new.started_at := now();
        return new;
      end if;
      if not is_app then
        if (to_jsonb(new) - 'org_id') <> (to_jsonb(old) - 'org_id') then
          raise exception 'expert call is immutable' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      if old.status <> 'running' or new.status = 'running'
        or (to_jsonb(new) - 'status' - 'failure_category' - 'opinion' - 'removed_findings'
            - 'provider' - 'model' - 'input_tokens' - 'output_tokens' - 'finished_at')
           <> (to_jsonb(old) - 'status' - 'failure_category' - 'opinion' - 'removed_findings'
            - 'provider' - 'model' - 'input_tokens' - 'output_tokens' - 'finished_at')
      then
        raise exception 'expert call is immutable' using errcode = 'check_violation';
      end if;
      if task_detached(v_task_id) and new.opinion is not null then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      new.finished_at := now();
      return new;
    end
    $$;
    create trigger expert_calls_guard before insert or update on expert_calls
      for each row execute function expert_calls_guard();

    -- 专家中心任务绑定的专家：新建后不能改
    create function tasks_expert_guard() returns trigger language plpgsql as $$
    begin
      if new.expert_id is distinct from old.expert_id then
        raise exception 'task expert is immutable' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger tasks_expert_guard before update on tasks
      for each row execute function tasks_expert_guard();

    -- 产物引用的专家调用不能改（草稿也不行）
    create function artifacts_consultation_guard() returns trigger language plpgsql as $$
    begin
      if new.consultation_id is distinct from old.consultation_id
        or new.emergency_signal is distinct from old.emergency_signal then
        raise exception 'artifact consultation is immutable' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger artifacts_consultation_guard before update on artifacts
      for each row execute function artifacts_consultation_guard();

    -- 反馈：只能针对已回复的意见；任务只读后不能再改
    create function expert_feedback_guard() returns trigger language plpgsql as $$
    declare
      v_status text;
      v_task_id uuid;
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      select e.status, c.task_id into v_status, v_task_id
        from expert_calls e join expert_consultations c on c.id = e.consultation_id
        where e.id = new.expert_call_id;
      if v_status is distinct from 'done' then
        raise exception 'only answered opinions take feedback' using errcode = 'check_violation';
      end if;
      if task_detached(v_task_id) then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      if tg_op = 'UPDATE' and (new.expert_call_id <> old.expert_call_id
        or new.manager_id <> old.manager_id or new.created_at <> old.created_at) then
        raise exception 'feedback identity is immutable' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger expert_feedback_guard before insert or update on expert_feedback
      for each row execute function expert_feedback_guard();

    -- 平台暂停、恢复专家的记录（Q11）。以所有者身份写入，应用不能伪造或删改。
    -- 用 after 触发器：upsert 遇到冲突时 before insert 也会触发，会多记一条
    create function expert_availability_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if tg_op = 'INSERT' or new.enabled is distinct from old.enabled then
        insert into expert_availability_events (expert_id, actor_id, action)
          values (new.expert_id, app_user_id(), case when new.enabled then 'resumed' else 'paused' end);
      end if;
      return null;
    end
    $$;
    revoke all on function expert_availability_audit() from public;
    create trigger expert_availability_audit after insert or update on expert_availability
      for each row execute function expert_availability_audit();

    create function expert_availability_touch() returns trigger language plpgsql as $$
    begin
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger expert_availability_touch before update on expert_availability
      for each row execute function expert_availability_touch();

    create trigger expert_availability_events_append_only
      before update or delete on expert_availability_events
      for each row execute function append_only();
  `.execute(db);

  // 不授予 delete：调用记录永久保留。调用和意见只开放结束时需要写的列
  const app = sql.id(APP_DB_ROLE);
  await sql`
    grant select, insert on expert_consultations, expert_calls to ${app};
    grant update (status, synthesis, synthesis_status, finished_at) on expert_consultations to ${app};
    grant update (
      status, failure_category, opinion, removed_findings, provider, model,
      input_tokens, output_tokens, finished_at
    ) on expert_calls to ${app};
    grant select, insert on expert_feedback to ${app};
    grant update (rating, reason, updated_at) on expert_feedback to ${app};
    -- 谁暂停的（updated_by）不对任何账号开放读取：暂停记录表里有操作人，只有平台管理员能看
    grant select (expert_id, enabled, updated_at) on expert_availability to ${app};
    grant insert on expert_availability to ${app};
    grant update (enabled, updated_by, updated_at) on expert_availability to ${app};
    grant select on expert_availability_events to ${app};
  `.execute(db);
}
