import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M2 报告上传、识别和核对（规格 2.3、2.4、2.6、3.1、3.2）。
 *
 * 新表：report_uploads（一次上传一条识别记录）、report_files（原件，存对象存储）、
 * extracted_values（待核对的识别结果）、report_events（操作记录，不记数值和原文）、
 * report_extraction_quota（每位健管师每天的识别页数，Q24）、storage_purge_queue（待清除的原件）。
 * 扩展：health_reports、report_indicators 补上核对来源、参考范围、原值和更正链。
 *
 * 隔离模型（沿用 0008）：
 * - 四张档案表都带租户列，复合外键 (client_id, manager_id) → clients on update cascade：
 *   客户转给别的健管师时跟着客户走。租户列由 client_record_tenant 从客户行填写。
 * - 只有服务该客户的健管师有策略。机构管理员看不到原件、识别记录和待核对的结果（Q14），
 *   只通过 health_reports、report_indicators 已有的策略读已核对的报告。运营商、平台没有策略。
 * - 状态机由触发器锁住（行级安全比较不了改前改后）：只能按顺序前进，已核对、已放弃后只读。
 * - 客户在识别中或待核对时转出（Q23）：未核对的识别结果作废，记录改为“失败（已转出）”，
 *   原件跟着客户走，新健管师可以重新识别。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    create table report_uploads (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      -- 上传时所在的任务（识别卡片显示在这里）；客户转出后置空，任务不跟着客户走（M1 Q11）
      task_id uuid references tasks (id) on delete set null,
      status text not null default 'queued' check (
        status in ('queued', 'processing', 'needs_review', 'verified', 'failed', 'discarded')
      ),
      failure_category text check (
        failure_category in (
          'not_a_report', 'unreadable', 'refused', 'timeout', 'too_large', 'error', 'transferred'
        )
      ),
      attempts int not null default 1 check (attempts between 0 and 3),
      -- 已被队列任务认领的是第几次识别：同一次识别的重复任务不能再认领（识别超时后除外）
      claimed_attempt int not null default 0 check (claimed_attempt between 0 and 3),
      -- 已退还页数的是第几次识别（入队失败时退还，规格 Q24），每次识别最多退一次
      quota_refunded_attempt int not null default 0 check (quota_refunded_attempt between 0 and 3),
      version int not null default 0 check (version >= 0),
      page_count int not null check (page_count between 1 and 30),
      progress_page int not null default 0 check (progress_page between 0 and 30),
      report_date date,
      institution text check (length(institution) between 1 and 100),
      report_id uuid,
      uploaded_by uuid not null references users (id),
      -- 发起当前这次识别的人：队列任务以他的身份执行（规格 3.2）
      requested_by uuid not null references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      verified_by uuid references users (id),
      verified_at timestamptz,
      critical_acknowledged boolean not null default false,
      unique (id, client_id),
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade,
      constraint report_uploads_failure check ((status = 'failed') = (failure_category is not null)),
      constraint report_uploads_verified check (
        (status = 'verified') = (report_id is not null and verified_by is not null and verified_at is not null)
      )
    );
    create index report_uploads_client_idx on report_uploads (client_id, created_at desc);
    create index report_uploads_task_idx on report_uploads (task_id);
    create index report_uploads_manager_idx on report_uploads (manager_id);

    create table report_files (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      upload_id uuid not null,
      seq int not null check (seq between 0 and 9),
      -- 随机 id，不含客户姓名和原文件名
      storage_key text not null unique check (storage_key ~ '^reports/[0-9a-f]{32}$'),
      mime_type text not null check (
        mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')
      ),
      size_bytes int not null check (size_bytes between 1 and 20971520),
      page_count int not null check (page_count between 1 and 30),
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
      -- 只存数据库用于显示，不进日志和存储路径
      original_name text not null check (length(original_name) between 1 and 255),
      created_at timestamptz not null default now(),
      purged_at timestamptz,
      unique (upload_id, seq),
      foreign key (upload_id, client_id) references report_uploads (id, client_id) on delete cascade,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index report_files_client_sha_idx on report_files (client_id, sha256);
    create index report_files_manager_idx on report_files (manager_id);

    create table extracted_values (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      upload_id uuid not null,
      seq int not null check (seq >= 0),
      raw_name text not null check (length(raw_name) between 1 and 100),
      code text check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
      raw_value text not null check (length(raw_value) <= 50),
      raw_unit text check (length(raw_unit) <= 30),
      value numeric(12, 3),
      unit text check (length(unit) <= 30),
      ref_low numeric(12, 3),
      ref_high numeric(12, 3),
      ref_text text check (length(ref_text) <= 60),
      page int check (page between 1 and 30),
      source_snippet text check (length(source_snippet) <= 200),
      flags text[] not null default '{}' check (
        flags <@ array['unreadable', 'out_of_bounds', 'unit_converted', 'unit_unknown',
                       'unmapped', 'conflict', 'duplicate']::text[]
      ),
      review_status text not null default 'pending' check (
        review_status in ('pending', 'checked', 'edited', 'deleted', 'added')
      ),
      checked_by uuid references users (id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (upload_id, seq),
      foreign key (upload_id, client_id) references report_uploads (id, client_id) on delete cascade,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index extracted_values_manager_idx on extracted_values (manager_id);

    create table report_events (
      id uuid primary key default gen_random_uuid(),
      operator_id uuid not null references operators (id),
      org_id uuid,
      manager_id uuid not null,
      client_id uuid not null,
      upload_id uuid,
      report_id uuid,
      -- 系统操作（转出作废、清除原件）没有操作人
      actor_id uuid references users (id),
      action text not null check (
        action in ('uploaded', 'extraction_started', 'extraction_failed', 'extraction_done',
                   'value_edited', 'value_added', 'value_deleted', 'value_checked', 'verified',
                   'discarded', 'corrected', 'file_viewed', 'file_purged', 'transferred')
      ),
      -- 只记哪一项，不记数值和原文
      extracted_value_id uuid,
      indicator_id uuid,
      file_id uuid,
      created_at timestamptz not null default clock_timestamp(),
      constraint report_events_target check (upload_id is not null or report_id is not null),
      foreign key (upload_id, client_id) references report_uploads (id, client_id) on delete cascade,
      foreign key (client_id, manager_id) references clients (id, manager_id)
        on update cascade on delete cascade,
      foreign key (manager_id, org_id) references users (id, org_id) on update cascade
    );
    create index report_events_upload_idx on report_events (upload_id, created_at);
    create index report_events_manager_idx on report_events (manager_id);

    -- 每位健管师每天的识别页数（Q24）。上限写在约束里，超出时写入失败
    create table report_extraction_quota (
      manager_id uuid not null references users (id),
      operator_id uuid not null references operators (id),
      day date not null,
      pages int not null check (pages between 0 and 200),
      primary key (manager_id, day)
    );

    -- 客户删除后待清除的原件（Q6）。只有所有者能读写，后台任务通过下面两个函数认领、完成
    create table storage_purge_queue (
      storage_key text primary key,
      created_at timestamptz not null default now(),
      -- 认领到期前不会再被认领；到期未完成（清除失败、进程退出）的下次重新认领
      claimed_until timestamptz
    );
  `.execute(db);

  // 已有的报告和指标：核对来源、检查机构、参考范围、原值和更正链
  await sql`
    alter table health_reports
      add column upload_id uuid,
      add column institution text check (length(institution) between 1 and 100),
      add column verified_by uuid references users (id),
      add column verified_at timestamptz,
      add constraint health_reports_upload_source check ((source = 'upload') = (upload_id is not null)),
      add unique (upload_id),
      add foreign key (upload_id, client_id) references report_uploads (id, client_id);
    alter table report_uploads
      add foreign key (report_id, client_id) references health_reports (id, client_id);
    alter table report_events
      add foreign key (report_id, client_id) references health_reports (id, client_id)
        on delete cascade;

    alter table report_indicators
      drop constraint report_indicators_report_id_code_key,
      alter column code drop not null,
      alter column value drop not null,
      add column raw_name text check (length(raw_name) between 1 and 100),
      add column original_value text check (length(original_value) <= 50),
      add column original_unit text check (length(original_unit) <= 30),
      add column ref_low numeric(12, 3),
      add column ref_high numeric(12, 3),
      add column ref_text text check (length(ref_text) <= 60),
      add column abnormal text not null default 'no_reference'
        check (abnormal in ('high', 'low', 'normal', 'no_reference')),
      -- 更正时指向新的一行；新行和旧行同一事务插入，外键延迟到提交时检查
      add column superseded_by uuid references report_indicators (id) deferrable initially deferred,
      add column created_at timestamptz not null default now(),
      -- 未收录指标（Q10）没有编码，必须有原始名称；目录指标必须有数值
      add constraint report_indicators_name check (code is not null or raw_name is not null),
      add constraint report_indicators_value check (code is null or value is not null);
    -- 同一份报告里每个目录指标只有一个当前值
    create unique index report_indicators_current_code
      on report_indicators (report_id, code) where superseded_by is null and code is not null;

    -- @ 引用的已核对报告（规格 2.6）
    alter table task_messages
      add column report_refs uuid[] not null default '{}' check (cardinality(report_refs) <= 1);
  `.execute(db);

  // 行级安全：只有服务该客户的健管师（Q14：机构管理员看不到原件、识别记录和待核对的结果）
  for (const table of ['report_uploads', 'report_files', 'extracted_values', 'report_events']) {
    const t = sql.table(table);
    await sql`
      alter table ${t} enable row level security;
      create policy ${sql.id(`${table}_manager`)} on ${t} for all
        using (app_role() = 'manager' and manager_id = app_user_id())
        with check (
          app_role() = 'manager' and manager_id = app_user_id()
          and operator_id = app_operator_id() and org_id is not distinct from app_org_id()
        );
      create trigger ${sql.id(`${table}_tenant`)} before insert or update on ${t}
        for each row execute function client_record_tenant();
    `.execute(db);
  }
  await sql`
    alter table report_extraction_quota enable row level security;
    create policy report_extraction_quota_manager on report_extraction_quota for all
      using (app_role() = 'manager' and manager_id = app_user_id())
      with check (
        app_role() = 'manager' and manager_id = app_user_id() and operator_id = app_operator_id()
      );
    alter table storage_purge_queue enable row level security;
  `.execute(db);

  // 识别记录的状态机（规格 2.3 第 8 条）
  await sql`
    create function report_uploads_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        new.updated_at := now();
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.status <> 'queued' or new.attempts <> 1 or new.version <> 0
          or new.progress_page <> 0 or new.report_id is not null or new.verified_by is not null
          or new.claimed_attempt <> 0 or new.quota_refunded_attempt <> 0
          or new.verified_at is not null or new.critical_acknowledged
          or new.uploaded_by is distinct from app_user_id()
          or new.requested_by is distinct from app_user_id()
        then
          raise exception 'upload must start queued by the current user' using errcode = 'check_violation';
        end if;
        -- 任务必须是自己的、关联的就是这位客户、没有断开（以调用者身份查，看不到按不存在）
        if new.task_id is not null and not exists (
          select 1 from tasks t
          where t.id = new.task_id and t.client_id = new.client_id and t.detached_reason is null
        ) then
          raise exception 'task must belong to the same client' using errcode = 'check_violation';
        end if;
        new.created_at := now();
        new.updated_at := now();
        return new;
      end if;

      if old.status in ('verified', 'discarded') then
        raise exception 'upload is read-only' using errcode = 'check_violation';
      end if;
      if new.id <> old.id or new.client_id <> old.client_id or new.uploaded_by <> old.uploaded_by
        or new.created_at <> old.created_at or new.page_count <> old.page_count
        or new.manager_id <> old.manager_id or new.operator_id <> old.operator_id
        or new.task_id is distinct from old.task_id
        or new.version < old.version
      then
        raise exception 'upload identity is immutable' using errcode = 'check_violation';
      end if;
      -- 只能按顺序前进；同一状态内可以更新进度、版本号
      if not (
        (old.status = new.status and new.status in ('queued', 'processing', 'needs_review'))
        or (old.status = 'queued' and new.status in ('processing', 'failed', 'discarded'))
        or (old.status = 'processing' and new.status in ('needs_review', 'failed', 'discarded'))
        or (old.status = 'needs_review' and new.status in ('verified', 'discarded'))
        or (old.status = 'failed' and new.status in ('queued', 'discarded'))
      ) then
        raise exception 'upload status cannot go from % to %', old.status, new.status
          using errcode = 'check_violation';
      end if;
      if old.status = 'failed' and new.status = 'queued' then
        -- 重新识别：次数加一（最多 3 次），由当前用户发起
        if new.attempts <> old.attempts + 1 or new.requested_by is distinct from app_user_id() then
          raise exception 'retry must count one attempt' using errcode = 'check_violation';
        end if;
      elsif new.attempts <> old.attempts or new.requested_by <> old.requested_by then
        raise exception 'attempts change only on retry' using errcode = 'check_violation';
      end if;
      -- 认领只能认领当前这次识别，并同时进入识别中；退还记录只由退还函数写
      if new.claimed_attempt <> old.claimed_attempt
        and (new.claimed_attempt <> new.attempts or new.status <> 'processing')
      then
        raise exception 'claim must match the current attempt' using errcode = 'check_violation';
      end if;
      if new.quota_refunded_attempt <> old.quota_refunded_attempt then
        raise exception 'quota refund is recorded by the system' using errcode = 'check_violation';
      end if;
      if new.status = 'verified' then
        if new.verified_by is distinct from app_user_id() or not exists (
          select 1 from health_reports r
          where r.id = new.report_id and r.upload_id = new.id and r.client_id = new.client_id
        ) then
          raise exception 'verified upload must point to its report' using errcode = 'check_violation';
        end if;
        new.verified_at := now();
      elsif new.report_id is not null or new.verified_by is not null
        or new.critical_acknowledged <> old.critical_acknowledged
      then
        raise exception 'only verification sets the report' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger report_uploads_guard before insert or update on report_uploads
      for each row execute function report_uploads_guard();

    -- 客户转出（Q23）：外键级联改了 manager_id。任务不跟着客户走，置空；
    -- 还没核对完的识别记录作废为“失败（已转出）”，次数清零，新健管师可以重新识别。
    create function report_uploads_transfer() returns trigger language plpgsql as $$
    begin
      if new.manager_id is distinct from old.manager_id then
        new.task_id := null;
        if old.status in ('queued', 'processing', 'needs_review', 'failed') then
          new.status := 'failed';
          new.failure_category := 'transferred';
          new.attempts := 0;
          new.claimed_attempt := 0;
          new.quota_refunded_attempt := 0;
          new.progress_page := 0;
          new.report_date := null;
          new.institution := null;
          new.version := old.version + 1;
          new.requested_by := new.manager_id;
        end if;
      end if;
      return new;
    end
    $$;
    create trigger report_uploads_transfer before update of manager_id on report_uploads
      for each row execute function report_uploads_transfer();

    -- 没核对通过的识别结果作废，不留数值（含已放弃的，Q23）；新作废的记一条系统记录
    create function report_uploads_after_transfer() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      delete from extracted_values where upload_id = new.id;
      if new.failure_category = 'transferred' and old.failure_category is distinct from 'transferred' then
        insert into report_events (operator_id, org_id, manager_id, client_id, upload_id, actor_id, action)
          values (new.operator_id, new.org_id, new.manager_id, new.client_id, new.id, null, 'transferred');
      end if;
      return null;
    end
    $$;
    revoke all on function report_uploads_after_transfer() from public;
    create trigger report_uploads_after_transfer after update of manager_id on report_uploads
      for each row
      when (new.manager_id is distinct from old.manager_id and new.status <> 'verified')
      execute function report_uploads_after_transfer();
  `.execute(db);

  // 原件、识别结果和操作记录的约束
  await sql`
    -- 原件只能和识别记录在同一个事务里由上传者写入（created_at = now() 即同一事务）；
    -- 之后只读，应用不能改也不能删
    create function report_files_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if not exists (
        select 1 from report_uploads u
        where u.id = new.upload_id and u.client_id = new.client_id and u.status = 'queued'
          and u.uploaded_by = app_user_id() and u.created_at = now()
      ) then
        raise exception 'files can only be added while uploading' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger report_files_guard before insert on report_files
      for each row execute function report_files_guard();

    -- 识别结果只在识别中（写入结果）和待核对（健管师修改）时可写；核对或放弃后只读
    create function extracted_values_guard() returns trigger language plpgsql as $$
    declare
      v_status text;
    begin
      if hb_is_system(tg_relid) then
        return coalesce(new, old);
      end if;
      select u.status into v_status from report_uploads u
        where u.id = coalesce(new.upload_id, old.upload_id);
      if v_status is null or v_status not in ('processing', 'needs_review') then
        raise exception 'extracted values are read-only' using errcode = 'check_violation';
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      if tg_op = 'UPDATE' and (new.upload_id <> old.upload_id or new.client_id <> old.client_id
        or new.seq <> old.seq or new.created_at <> old.created_at)
      then
        raise exception 'extracted value identity is immutable' using errcode = 'check_violation';
      end if;
      if new.checked_by is not null and new.checked_by is distinct from app_user_id()
        and (tg_op = 'INSERT' or new.checked_by is distinct from old.checked_by)
      then
        raise exception 'checked by must be the current user' using errcode = 'check_violation';
      end if;
      new.updated_at := now();
      return new;
    end
    $$;
    create trigger extracted_values_guard before insert or update or delete on extracted_values
      for each row execute function extracted_values_guard();

    -- 操作记录：应用只能以本人名义记录；只能追加
    create function report_events_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if new.actor_id is distinct from app_user_id() or new.action in ('file_purged', 'transferred') then
        raise exception 'event must be recorded as the current user' using errcode = 'check_violation';
      end if;
      new.created_at := clock_timestamp();
      return new;
    end
    $$;
    create trigger report_events_guard before insert on report_events
      for each row execute function report_events_guard();
    create trigger report_events_append_only before update or delete on report_events
      for each row execute function append_only();
  `.execute(db);

  // 正式报告和指标：上传来源的报告只能在核对时写入，之后只读，更正走“插入新行 + 旧行指向新行”
  await sql`
    create function health_reports_upload_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.upload_id is not null and (
          new.verified_by is distinct from app_user_id() or not exists (
            select 1 from report_uploads u
            where u.id = new.upload_id and u.client_id = new.client_id and u.status = 'needs_review'
          )
        ) then
          raise exception 'report must come from an upload under review' using errcode = 'check_violation';
        end if;
        if new.upload_id is null and (new.verified_by is not null or new.verified_at is not null) then
          raise exception 'only uploads are verified' using errcode = 'check_violation';
        end if;
        new.verified_at := case when new.upload_id is null then null else now() end;
        return new;
      end if;
      if old.upload_id is not null then
        raise exception 'verified report is read-only' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger health_reports_upload_guard before insert or update on health_reports
      for each row execute function health_reports_upload_guard();

    -- 上传来源的报告和指标不能删除（合成数据沿用 M0 的规则，仍可由健管师删除）。
    -- 客户删除时的级联删除是系统操作，不受影响
    create function report_upload_rows_no_delete() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return old;
      end if;
      -- 分两层 if：plpgsql 的 and 不保证短路，两张表的列不同
      if tg_table_name = 'health_reports' then
        if old.upload_id is not null then
          raise exception 'verified report cannot be deleted' using errcode = 'check_violation';
        end if;
      elsif exists (
        select 1 from health_reports r where r.id = old.report_id and r.upload_id is not null
      ) then
        raise exception 'verified report cannot be deleted' using errcode = 'check_violation';
      end if;
      return old;
    end
    $$;
    create trigger health_reports_no_delete before delete on health_reports
      for each row execute function report_upload_rows_no_delete();
    create trigger report_indicators_no_delete before delete on report_indicators
      for each row execute function report_upload_rows_no_delete();

    create function report_indicators_guard() returns trigger language plpgsql as $$
    declare
      v_upload uuid;
      v_status text;
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      select r.upload_id into v_upload from health_reports r where r.id = new.report_id;
      if tg_op = 'INSERT' then
        if new.superseded_by is not null then
          raise exception 'new indicator cannot be superseded' using errcode = 'check_violation';
        end if;
        new.created_at := now();
        return new;
      end if;
      -- 更正：旧行只能被指向同一份报告的新行一次，其余内容不变
      if old.superseded_by is not null then
        raise exception 'superseded indicator is read-only' using errcode = 'check_violation';
      end if;
      if new.superseded_by is not null then
        if (to_jsonb(new) - 'superseded_by' - 'operator_id' - 'org_id' - 'manager_id')
          <> (to_jsonb(old) - 'superseded_by' - 'operator_id' - 'org_id' - 'manager_id')
        then
          raise exception 'correction keeps the old value' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      -- 上传来源的报告：已核对的数值不能直接改（规格 2.4）
      if v_upload is not null then
        raise exception 'verified indicator is read-only' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger report_indicators_guard before insert or update on report_indicators
      for each row execute function report_indicators_guard();

    -- 更正指向的新行必须属于同一份报告（新行在同一事务里稍后插入，所以在提交时检查）
    create function report_indicators_superseded_check() returns trigger language plpgsql as $$
    begin
      if new.superseded_by is not null and not exists (
        select 1 from report_indicators n
        where n.id = new.superseded_by and n.report_id = new.report_id and n.id <> new.id
          and n.superseded_by is null
      ) then
        raise exception 'correction must stay in the same report' using errcode = 'check_violation';
      end if;
      return null;
    end
    $$;
    create constraint trigger report_indicators_superseded_check
      after update of superseded_by on report_indicators deferrable initially deferred
      for each row execute function report_indicators_superseded_check();

    -- @ 引用的报告必须属于任务关联的客户（以调用者身份查，看不到的报告按不存在处理）
    create function task_messages_report_refs_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) or cardinality(new.report_refs) = 0 then
        return new;
      end if;
      if not exists (
        select 1 from health_reports r join tasks t on t.client_id = r.client_id
        where r.id = new.report_refs[1] and t.id = new.task_id
      ) then
        raise exception 'message can only reference reports of the task client'
          using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger task_messages_report_refs_guard before insert or update on task_messages
      for each row execute function task_messages_report_refs_guard();
  `.execute(db);

  // 客户转出或删除时，消息里也不再保留对这位客户报告的引用（沿用 0004 的处理，加一行）
  await sql`
    create or replace function detach_client_work(p_client_id uuid, p_reason text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      with voided as (
        update artifacts set status = 'voided'
          where status = 'draft'
            and (client_id = p_client_id
                 or task_id in (select t.id from tasks t where t.client_id = p_client_id))
          returning id, operator_id, org_id, manager_id
      )
      insert into artifact_events (artifact_id, operator_id, org_id, manager_id, actor_id, action)
        select id, operator_id, org_id, manager_id, null, 'voided' from voided;

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

    -- 客户的机构或协会变了而健管师没变：新表的租户列也跟着同步（沿用 0008，加上新表）
    create or replace function clients_sync_record_tenant() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      t text;
    begin
      foreach t in array array['health_reports', 'report_indicators', 'client_health_history',
                               'client_risk_tiers', 'report_uploads', 'report_files',
                               'extracted_values', 'report_events']
      loop
        execute format(
          'update %I set operator_id = $1, org_id = $2 where client_id = $3 '
          'and (operator_id is distinct from $1 or org_id is distinct from $2)', t)
          using new.operator_id, new.org_id, new.id;
      end loop;
      return new;
    end
    $$;
    revoke all on function clients_sync_record_tenant() from public;
  `.execute(db);

  // 原件清除（Q6）：原件行被删除（客户删除时级联）时，把存储 key 记下来，由后台定期清除
  await sql`
    create function report_files_enqueue_purge() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      insert into storage_purge_queue (storage_key) values (old.storage_key)
        on conflict do nothing;
      return old;
    end
    $$;
    revoke all on function report_files_enqueue_purge() from public;
    create trigger report_files_enqueue_purge after delete on report_files
      for each row execute function report_files_enqueue_purge();

    -- 只给后台任务用：带用户身份（租户上下文）的会话调用时拒绝。
    -- 认领即占用：认领到的 key 在 15 分钟内不会再被列出，不能只列不取。
    create function storage_purge_claim(p_limit int) returns setof text
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'storage purge is a system task' using errcode = 'insufficient_privilege';
      end if;
      return query
        update storage_purge_queue q set claimed_until = now() + interval '15 minutes'
        where q.storage_key in (
          select storage_key from storage_purge_queue
          where claimed_until is null or claimed_until < now()
          order by created_at
          limit least(greatest(p_limit, 0), 100)
          for update skip locked
        )
        returning q.storage_key;
    end
    $$;
    -- 只删除认领中的 key
    create function storage_purge_done(p_keys text[]) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is not null or app_user_id() is not null then
        raise exception 'storage purge is a system task' using errcode = 'insufficient_privilege';
      end if;
      delete from storage_purge_queue
      where storage_key = any (p_keys) and claimed_until is not null and claimed_until >= now();
    end
    $$;
    revoke all on function storage_purge_claim(int) from public;
    revoke all on function storage_purge_done(text[]) from public;

    -- 队列任务只带 upload_id：执行时按这个函数找到发起识别的人，再以他的身份建立租户上下文。
    -- 只对排队中、识别中的记录返回，只返回身份信息，不返回任何业务数据。
    create function report_upload_requester(p_upload_id uuid)
      returns table (user_id uuid, role user_role, operator_id uuid, org_id uuid)
      language sql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
      select u.id, u.role, u.operator_id, u.org_id
      from report_uploads r
      join users u on u.id = r.requested_by
      left join operators o on o.id = u.operator_id
      where r.id = p_upload_id and r.status in ('queued', 'processing')
        and r.requested_by = r.manager_id and u.role = 'manager'
        and u.status = 'active' and coalesce(o.status = 'active', true)
    $$;
    revoke all on function report_upload_requester(uuid) from public;

    -- 入队失败时退还这次识别预占的页数（Q24）。只退调用者自己发起、还没被认领、
    -- 因入队失败（error）结束的这一次识别，每次识别最多退一次。返回是否退还。
    create function report_quota_refund(p_upload_id uuid) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      r report_uploads%rowtype;
    begin
      select * into r from report_uploads where id = p_upload_id for update;
      if not found or app_role() is distinct from 'manager'
        or r.manager_id is distinct from app_user_id() or r.requested_by is distinct from app_user_id()
        or r.status <> 'failed' or r.failure_category is distinct from 'error'
        or r.attempts = 0 or r.claimed_attempt = r.attempts or r.quota_refunded_attempt = r.attempts
      then
        return false;
      end if;
      update report_uploads set quota_refunded_attempt = r.attempts where id = r.id;
      update report_extraction_quota set pages = greatest(pages - r.page_count, 0)
        where manager_id = r.manager_id and day = current_date;
      return true;
    end
    $$;
    revoke all on function report_quota_refund(uuid) from public;

    -- 应用只能增加当天的页数，减少只能经过上面的退还函数
    create function report_extraction_quota_guard() returns trigger language plpgsql as $$
    begin
      if not hb_is_system(tg_relid) and new.pages < old.pages then
        raise exception 'quota pages can only increase' using errcode = 'check_violation';
      end if;
      if new.manager_id <> old.manager_id or new.day <> old.day or new.operator_id <> old.operator_id then
        raise exception 'quota row is immutable' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger report_extraction_quota_guard before update on report_extraction_quota
      for each row execute function report_extraction_quota_guard();
  `.execute(db);

  await sql`
    grant select, insert on report_uploads to ${app};
    grant update (status, failure_category, attempts, claimed_attempt, version, progress_page,
                  report_date, institution, report_id, requested_by, verified_by,
                  critical_acknowledged)
      on report_uploads to ${app};
    grant select, insert on report_files to ${app};
    grant select, insert on extracted_values to ${app};
    grant update (raw_name, code, raw_value, raw_unit, value, unit, ref_low, ref_high, ref_text,
                  flags, review_status, checked_by)
      on extracted_values to ${app};
    grant select, insert on report_events to ${app};
    grant select, insert on report_extraction_quota to ${app};
    grant update (pages) on report_extraction_quota to ${app};

    -- 报告和指标：上传来源的报告由触发器锁成只读、不能删除；更正只开放 superseded_by
    grant update (superseded_by) on report_indicators to ${app};

    grant execute on function storage_purge_claim(int), storage_purge_done(text[]),
      report_upload_requester(uuid), report_quota_refund(uuid) to ${app};
  `.execute(db);
}
