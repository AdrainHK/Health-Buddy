import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M6 伴侣“福宝”第 6 步（6b-1）：`/转交回复` 让 AI 起草回复（规格 2.4、2.9，Q25、N13）。
 *
 * - task_messages.handoff_ref：健管师这句话 @ 的转交（最多 1 个）。必须是任务客户的、调用者看得到的
 *   （只有服务这位客户的健管师看得到）；客户转出（任务断开）时由系统置空。
 * - artifacts：kind = handoff_reply 的产物只有专业版，回复原文和对应的转交放在 structured
 *   （{ handoffId, reply }）。草稿时健管师可以改回复；对应的转交生成后不能改（后端校验）。
 * - companion_handoffs.reply_artifact_id：回复来自哪份草稿。写回复时如果带了它，数据库再校验一遍：
 *   必须是本人已审核的 handoff_reply 产物、对应这个转交和客户、回复原文一致（红线 3：草稿审核通过后才能发送）。
 * - task_steps.kind 加 read_companion（正在读取伴侣信息）；artifact_events 加动作 companion_reply_sent。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    alter table task_messages add column handoff_ref uuid;

    create function task_messages_handoff_ref_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'UPDATE' and new.handoff_ref is not distinct from old.handoff_ref
        and new.task_id = old.task_id
      then
        return new;
      end if;
      -- 以调用者身份查（受行级安全约束）：别人的转交看不到，按不存在处理
      if new.handoff_ref is not null and not exists (
        select 1 from companion_handoffs h
        join tasks t on t.id = new.task_id and t.client_id = h.client_id
        where h.id = new.handoff_ref
      ) then
        raise exception 'message can only reference handoffs of the task client'
          using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger task_messages_handoff_ref_guard before insert or update on task_messages
      for each row execute function task_messages_handoff_ref_guard();

    -- 客户转出或删除（任务断开）时，消息里 @ 的转交也置空：转交跟着客户走
    create function tasks_detach_handoff_refs() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      update task_messages set handoff_ref = null
        where task_id = new.id and handoff_ref is not null;
      return null;
    end
    $$;
    revoke all on function tasks_detach_handoff_refs() from public;
    create trigger tasks_detach_handoff_refs after update of client_id on tasks
      for each row when (old.client_id is not null and new.client_id is null)
      execute function tasks_detach_handoff_refs();

    alter table artifacts
      add constraint artifacts_handoff_reply check (
        kind <> 'handoff_reply' or (
          jsonb_typeof(structured -> 'reply') = 'string'
          and (structured ->> 'handoffId') ~ '^[0-9a-f-]{36}$'
        )
      );

    alter table task_steps
      drop constraint task_steps_kind_check,
      add constraint task_steps_kind_check check (
        kind in (
          'read_client', 'read_report', 'compare_reports', 'detect_critical', 'run_skill', 'answer',
          'route_experts', 'consult_experts', 'consult_expert', 'synthesize_experts',
          'read_twin', 'compute_forecast',
          'read_care_plan', 'select_library_items', 'schedule_visits', 'read_visit_materials',
          'read_visit_records', 'read_companion'
        )
      );

    alter table companion_handoffs
      add column reply_artifact_id uuid references artifacts (id),
      add constraint companion_handoffs_reply_artifact_check
        check (reply_artifact_id is null or reply_text is not null);

    create or replace function companion_handoffs_guard() returns trigger
      language plpgsql set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if hb_is_system(tg_relid) then
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
        -- 来自 AI 草稿的回复：必须是本人已审核的 /转交回复 产物，对应这个转交和客户，原文一致（红线 3）
        if new.reply_artifact_id is not null and not exists (
          select 1 from artifacts a
          where a.id = new.reply_artifact_id
            and a.kind = 'handoff_reply'
            and a.status = 'approved'
            and a.manager_id = app_user_id()
            and a.client_id = new.client_id
            and a.structured ->> 'handoffId' = new.id::text
            and a.structured ->> 'reply' = new.reply_text
        ) then
          raise exception 'reply artifact must be an approved draft for this handoff'
            using errcode = 'check_violation';
        end if;
        new.replied_by := app_user_id();
        new.replied_at := now();
        new.closed_by := null;
        new.closed_at := null;
      elsif new.status in ('closed_by_call', 'closed') and old.status in ('open', 'replied')
        and new.reply_text is not distinct from old.reply_text
        and new.reply_artifact_id is not distinct from old.reply_artifact_id then
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
    grant update (reply_artifact_id) on companion_handoffs to ${app};

    -- 产物记录：/转交回复 审核后发送给福宝
    alter table artifact_events drop constraint artifact_events_action_check;
    alter table artifact_events add constraint artifact_events_action_check check (
      action in ('created', 'edited', 'approved', 'returned', 'voided', 'copied', 'exported',
                 'companion_synced', 'companion_withdrawn', 'companion_reply_sent')
    );
  `.execute(db);
}
