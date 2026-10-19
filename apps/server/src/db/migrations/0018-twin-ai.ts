import { sql, type Kysely } from 'kysely';

/**
 * M4 第 4 步：/孪生小结、@孪生项、“请专家看看”（规格 2.6 之二、2.7–2.9、7.2）。
 *
 * - task_messages.twin_refs：@ 引用的孪生项，JSON 数组，每项只有 kind（domain / metric）和 code，
 *   最多 3 个。不含任何数值和客户资料；客户归属由后端在发消息时校验（任务关联的客户）。
 * - task_steps.kind 增加 read_twin（正在读取数字孪生）、compute_forecast（正在计算趋势）。
 * - expert_consultations.trigger 增加 twin；新增 follow_up_item_id（从跟进项发起时）和 twin_refs。
 *   复合外键 (follow_up_item_id, client_id) → follow_up_items (id, client_id) 保证跟进项属于调用的客户；
 *   插入时触发器再确认跟进项属于同一位健管师（触发器以调用者权限执行，受行级安全约束）。
 *   客户转出后调用记录的 client_id 被置空（M3 原规则），复合外键不再检查，跟进项跟着客户走（Q23）。
 *   跟进项随客户删除时，调用记录的 follow_up_item_id 置空（系统级联，触发器放行）。
 *
 * 新列都在插入时写好，之后和其他列一样不可修改（触发器按整行比较）。授权不变：
 * task_messages、expert_consultations 的 insert 是整表授权，update 没有开放新列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table task_messages
      add column twin_refs jsonb not null default '[]' check (
        jsonb_typeof(twin_refs) = 'array' and jsonb_array_length(twin_refs) <= 3
      );

    alter table task_steps
      drop constraint task_steps_kind_check,
      add constraint task_steps_kind_check check (
        kind in (
          'read_client', 'read_report', 'compare_reports', 'detect_critical', 'run_skill', 'answer',
          'route_experts', 'consult_experts', 'consult_expert', 'synthesize_experts',
          'read_twin', 'compute_forecast'
        )
      );

    alter table expert_consultations
      drop constraint expert_consultations_trigger_check,
      add constraint expert_consultations_trigger_check check (
        trigger in ('expert_center', 'mention', 'skill_auto', 'plan', 'twin')
      ),
      add column follow_up_item_id uuid,
      add column twin_refs jsonb check (
        twin_refs is null or (jsonb_typeof(twin_refs) = 'array' and jsonb_array_length(twin_refs) <= 3)
      ),
      -- 跟进项只能随“请专家看看”（twin）一起
      add constraint expert_consultations_follow_up check (
        follow_up_item_id is null or trigger = 'twin'
      ),
      add foreign key (follow_up_item_id, client_id) references follow_up_items (id, client_id)
        on delete set null (follow_up_item_id);
    create index expert_consultations_follow_up_idx on expert_consultations (follow_up_item_id);
  `.execute(db);

  // 沿用 0012 的规则，加上：插入时跟进项必须属于同一位健管师；系统级联可以把 follow_up_item_id 置空
  await sql`
    create or replace function expert_consultations_guard() returns trigger language plpgsql as $$
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
        if new.follow_up_item_id is not null and (
          new.client_id is null or not exists (
            select 1 from follow_up_items f
            where f.id = new.follow_up_item_id
              and f.client_id = new.client_id
              and f.manager_id = new.manager_id
          )
        ) then
          raise exception 'follow-up item must belong to the same client and manager'
            using errcode = 'check_violation';
        end if;
        new.created_at := now();
        return new;
      end if;
      if not is_app then
        -- 系统只做级联：客户置空、跟随健管师调机构、报告删除时置空、跟进项删除时置空
        if (to_jsonb(new) - 'client_id' - 'org_id' - 'report_id' - 'follow_up_item_id')
           <> (to_jsonb(old) - 'client_id' - 'org_id' - 'report_id' - 'follow_up_item_id')
          or (new.client_id is distinct from old.client_id and new.client_id is not null)
          or (new.report_id is distinct from old.report_id and new.report_id is not null)
          or (new.follow_up_item_id is distinct from old.follow_up_item_id
              and new.follow_up_item_id is not null)
        then
          raise exception 'consultation is immutable' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      -- 应用：只允许 running 改为终态一次，同时写汇总、信号和结束时间（0013）
      if old.status <> 'running' or new.status = 'running'
        or (to_jsonb(new) - 'status' - 'synthesis' - 'synthesis_status' - 'finished_at'
              - 'crisis_signal' - 'emergency_signal')
           <> (to_jsonb(old) - 'status' - 'synthesis' - 'synthesis_status' - 'finished_at'
              - 'crisis_signal' - 'emergency_signal')
      then
        raise exception 'consultation is immutable' using errcode = 'check_violation';
      end if;
      -- 信号不能清除
      if (old.crisis_signal and not new.crisis_signal)
        or (old.emergency_signal and not new.emergency_signal)
      then
        raise exception 'consultation signals cannot be cleared' using errcode = 'check_violation';
      end if;
      -- 任务已只读（客户转出）时只能结束，不能再写汇总
      if task_detached(old.task_id) and new.synthesis is not null then
        raise exception 'task is read-only' using errcode = 'check_violation';
      end if;
      new.finished_at := now();
      return new;
    end
    $$;
  `.execute(db);
}
