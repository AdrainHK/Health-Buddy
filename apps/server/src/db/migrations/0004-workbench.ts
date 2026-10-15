import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M1 工作台：任务、消息、执行步骤、计划、产物和产物记录（规格第五节）。
 *
 * 隔离模型：
 * - 六张表都只对“健管师本人”开放。不照抄客户表的策略（它对机构管理员开放），
 *   也不用 exists 查 clients 推导可见性，因为客户转出后原健管师仍要能看到自己的历史任务。
 * - 复合外键保证子表、产物和任务属于同一个健管师；(manager_id, org_id) 跟着健管师调机构。
 * - 产物状态在数据库层锁住：只能以草稿插入；状态只能从草稿往前走；非草稿行不能改。
 * - 客户转出或删除时，由触发器在同一事务里把相关任务断开、归档并作废草稿（Q11）。
 *
 * “系统操作”指的是以表所有者身份执行的语句（SECURITY DEFINER 函数、外键级联），
 * 触发器用 hb_is_system 区分：应用不能自己作废草稿、断开客户、改只读任务或伪造产物记录。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table clients add constraint clients_id_manager_key unique (id, manager_id);

    create table tasks (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid,
      title text not null check (length(title) between 1 and 100),
      archived_at timestamptz,
      detached_reason text check (detached_reason in ('client_transferred', 'client_deleted')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, manager_id),
      unique (id, client_id, manager_id),
      foreign key (manager_id, operator_id) references users (id, operator_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      -- 只能关联自己的客户；客户被删除时只把 client_id 置空，任务保留
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on delete set null (client_id),
      -- 断开的任务一定已归档
      constraint tasks_detached_archived check (detached_reason is null or archived_at is not null)
    );
    create index tasks_manager_idx on tasks (manager_id, updated_at desc);
    create index tasks_client_idx on tasks (client_id);

    create table task_messages (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      role text not null check (role in ('manager', 'assistant')),
      mode text not null check (mode in ('ask', 'plan', 'craft')),
      content text not null default '',
      skill_id text check (skill_id ~ '^[a-z][a-z0-9-]{1,63}$'),
      client_refs uuid[] not null default '{}' check (cardinality(client_refs) <= 1),
      status text not null check (status in ('streaming', 'complete', 'stopped', 'refused', 'error')),
      created_at timestamptz not null default now(),
      unique (id, manager_id),
      foreign key (task_id, manager_id) references tasks (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index task_messages_task_idx on task_messages (task_id, created_at);

    create table task_steps (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      seq int not null check (seq >= 0),
      kind text not null check (kind in ('read_client', 'detect_critical', 'run_skill', 'answer')),
      -- i18n 键，不存自由文本
      label_key text not null check (label_key ~ '^[a-z][a-zA-Z0-9_.]{1,100}$'),
      status text not null check (status in ('running', 'done', 'failed')),
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      unique (message_id, seq),
      foreign key (message_id, manager_id) references task_messages (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );

    create table task_plans (
      id uuid primary key default gen_random_uuid(),
      message_id uuid not null,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      steps jsonb not null check (jsonb_typeof(steps) = 'array'),
      status text not null check (status in ('proposed', 'confirmed', 'revised')),
      created_at timestamptz not null default now(),
      foreign key (message_id, manager_id) references task_messages (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );

    create table artifacts (
      id uuid primary key default gen_random_uuid(),
      task_id uuid not null,
      client_id uuid,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      skill_id text not null check (skill_id ~ '^[a-z][a-z0-9-]{1,63}$'),
      kind text not null,
      -- 同一产物的所有版本共用 lineage_id（第一版的 id）
      lineage_id uuid not null,
      version int not null check (version >= 1),
      parent_id uuid,
      status text not null check (status in ('draft', 'approved', 'returned', 'voided')),
      content jsonb not null check (
        jsonb_typeof(content -> 'professional') = 'string'
        and jsonb_typeof(content -> 'clientFacing') = 'string'
      ),
      critical_flags jsonb not null default '[]' check (jsonb_typeof(critical_flags) = 'array'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, manager_id),
      unique (id, task_id),
      unique (lineage_id, version),
      -- 产物的客户必须和任务一致；任务断开客户时级联置空
      foreign key (task_id, client_id, manager_id) references tasks (id, client_id, manager_id)
        on update cascade,
      foreign key (task_id, manager_id) references tasks (id, manager_id),
      -- 上一版只能是同一任务的产物
      foreign key (parent_id, task_id) references artifacts (id, task_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint artifacts_first_version check (
        (version = 1 and parent_id is null and lineage_id = id)
        or (version > 1 and parent_id is not null)
      )
    );
    create index artifacts_task_idx on artifacts (task_id, created_at);

    create table artifact_events (
      id uuid primary key default gen_random_uuid(),
      artifact_id uuid not null,
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      -- 系统操作（作废）没有操作人
      actor_id uuid references users (id),
      action text not null check (
        action in ('created', 'edited', 'approved', 'returned', 'voided', 'copied', 'exported')
      ),
      reason text check (length(reason) <= 500),
      format text check (format in ('png', 'pdf')),
      created_at timestamptz not null default now(),
      foreign key (artifact_id, manager_id) references artifacts (id, manager_id),
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint artifact_events_format check ((action = 'exported') = (format is not null))
    );
    create index artifact_events_artifact_idx on artifact_events (artifact_id, created_at);
  `.execute(db);

  // 行级安全：只放行健管师本人；写入时租户字段必须和当前上下文一致
  for (const table of [
    'tasks',
    'task_messages',
    'task_steps',
    'task_plans',
    'artifacts',
    'artifact_events',
  ]) {
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

  // 系统操作的判定：当前身份是表的所有者（SECURITY DEFINER 函数、外键级联、迁移和合成数据脚本）。
  // 反过来判断“是不是应用角色”不可靠：以后新增别的受限角色时，它会被误当成系统。
  await sql`
    create function hb_is_system(p_rel oid) returns boolean language sql stable as $$
      select current_user = pg_get_userbyid(c.relowner) from pg_class c where c.oid = p_rel
    $$;

    -- 任务是否已断开（只读）。以调用者身份执行，看不到的任务按未断开处理，由外键另行拦截。
    create function task_detached(p_task_id uuid) returns boolean language sql stable as $$
      select coalesce((select t.detached_reason is not null from tasks t where t.id = p_task_id), false)
    $$;
  `.execute(db);

  // 产物状态机（规格 3.6）
  await sql`
    create function artifacts_guard() returns trigger language plpgsql as $$
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
        -- 非草稿行只允许系统把客户置空（客户转出或删除）和跟随健管师调机构
        if is_app
          or (to_jsonb(new) - 'client_id' - 'org_id' - 'updated_at')
             <> (to_jsonb(old) - 'client_id' - 'org_id' - 'updated_at')
          or (new.client_id is distinct from old.client_id and new.client_id is not null)
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
    create trigger artifacts_guard before insert or update on artifacts
      for each row execute function artifacts_guard();

    -- 任务：客户一旦关联就不能换；断开的任务只读；断开只能由系统做
    create function tasks_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.detached_reason is not null or new.archived_at is not null then
          raise exception 'new task cannot be archived or detached' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      if old.detached_reason is not null then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      if new.detached_reason is not null
        or (old.client_id is not null and new.client_id is distinct from old.client_id)
        or new.manager_id <> old.manager_id or new.operator_id <> old.operator_id
        or new.created_at <> old.created_at
      then
        raise exception 'task identity is immutable' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger tasks_guard before insert or update on tasks
      for each row execute function tasks_guard();

    -- 消息、步骤、计划：所属任务断开后只读；消息引用的客户只能是任务的客户（规格第六节）
    create function task_children_guard() returns trigger language plpgsql as $$
    declare
      v_task_id uuid;
      v_client_id uuid;
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_table_name = 'task_messages' then
        v_task_id := new.task_id;
      else
        select m.task_id into v_task_id from task_messages m where m.id = new.message_id;
      end if;
      if task_detached(v_task_id) then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      -- 分两层 if：plpgsql 的 and 不保证短路，别的表没有 client_refs 列
      if tg_table_name = 'task_messages' then
        if cardinality(new.client_refs) > 0 then
          select t.client_id into v_client_id from tasks t where t.id = v_task_id;
          if v_client_id is null or new.client_refs <> array[v_client_id] then
            raise exception 'message can only reference the task client'
              using errcode = 'check_violation';
          end if;
        end if;
      end if;
      return new;
    end
    $$;
    create trigger task_messages_guard before insert or update on task_messages
      for each row execute function task_children_guard();
    create trigger task_steps_guard before insert or update on task_steps
      for each row execute function task_children_guard();
    create trigger task_plans_guard before insert or update on task_plans
      for each row execute function task_children_guard();

    -- 产物记录：应用只能以本人名义记录自己能做的动作；复制和导出只针对已审核产物
    create function artifact_events_guard() returns trigger language plpgsql as $$
    declare
      v_status text;
      v_task_id uuid;
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.actor_id is distinct from app_user_id() or new.action = 'voided' then
        raise exception 'event must be recorded as the current user' using errcode = 'check_violation';
      end if;
      select a.status, a.task_id into v_status, v_task_id from artifacts a where a.id = new.artifact_id;
      if task_detached(v_task_id) then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      if new.action in ('approved', 'copied', 'exported') and v_status is distinct from 'approved' then
        raise exception 'artifact is not approved' using errcode = 'check_violation';
      end if;
      if new.action = 'returned' and v_status is distinct from 'returned' then
        raise exception 'artifact is not returned' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger artifact_events_guard before insert on artifact_events
      for each row execute function artifact_events_guard();

    -- 产物记录只能追加。系统操作除外：外键级联（健管师调机构时更新 org_id）、
    -- 合成数据脚本清理演示协会。
    create function append_only() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return coalesce(new, old);
      end if;
      raise exception '% is append-only', tg_table_name using errcode = 'check_violation';
    end
    $$;
    create trigger artifact_events_append_only before update or delete on artifact_events
      for each row execute function append_only();
  `.execute(db);

  // 客户转出或删除（Q11）：断开任务、归档、作废草稿，并记一条系统作废记录。
  // 以所有者身份执行，不受行级安全约束，无论由谁触发转移都能处理完整。
  await sql`
    create function detach_client_work(p_client_id uuid, p_reason text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      -- 按任务作废：任务关联客户之前生成的草稿（client_id 为空）也一并作废
      with voided as (
        update artifacts set status = 'voided'
          where status = 'draft'
            and (client_id = p_client_id
                 or task_id in (select t.id from tasks t where t.client_id = p_client_id))
          returning id, operator_id, org_id, manager_id
      )
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        select id, operator_id, org_id, manager_id, null, 'voided' from voided;

      -- 消息里不再保留对这位客户的引用
      update task_messages set client_refs = '{}'
        where task_id in (select t.id from tasks t where t.client_id = p_client_id);

      -- 置空 client_id 会经外键级联到 artifacts.client_id
      update tasks set
          client_id = null,
          detached_reason = p_reason,
          archived_at = coalesce(archived_at, now()),
          updated_at = now()
        where client_id = p_client_id;
    end
    $$;
    revoke all on function detach_client_work(uuid, text) from public;

    create function clients_detach_work() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if tg_op = 'DELETE' then
        perform detach_client_work(old.id, 'client_deleted');
        return old;
      end if;
      if new.manager_id <> old.manager_id then
        perform detach_client_work(old.id, 'client_transferred');
      end if;
      return new;
    end
    $$;
    revoke all on function clients_detach_work() from public;
    create trigger clients_detach_work before update of manager_id or delete on clients
      for each row execute function clients_detach_work();
  `.execute(db);

  // 不授予 delete：任务只归档不删除（Q3），产物和记录永久保留。
  // 消息、步骤、计划只开放流式写入需要的列，历史对话不能事后改写。
  const app = sql.id(APP_DB_ROLE);
  await sql`
    grant select, insert, update on tasks, artifacts to ${app};
    grant select, insert on task_messages, task_steps, task_plans, artifact_events to ${app};
    grant update (content, status) on task_messages to ${app};
    grant update (status, finished_at) on task_steps to ${app};
    grant update (status) on task_plans to ${app};
    grant execute on function hb_is_system(oid), task_detached(uuid) to ${app};
  `.execute(db);
}
