import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * 专家调用的心理危机 / 疑似急症信号（M3 合规审查第 1 条）。
 *
 * 专家都没回复、调用被停止时汇总为空，信号不能只存在汇总里：在调用上单独存两列，
 * 值由后端合并关键词识别、每位专家（包括意见没通过校验的）和汇总。
 * - 插入时写入关键词识别的结果；结束（running 改为终态）时写入合并后的结果。
 * - 信号只能从 false 变成 true，不能清除；调用结束后和其他列一样不可修改。
 * - 隔离沿用 0012：只对健管师本人开放，应用账号只多授予这两列的更新权限。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table expert_consultations
      add column crisis_signal boolean not null default false,
      add column emergency_signal boolean not null default false;

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
      -- 应用：只允许 running 改为终态一次，同时写汇总、信号和结束时间
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

  const app = sql.id(APP_DB_ROLE);
  await sql`
    grant update (crisis_signal, emergency_signal) on expert_consultations to ${app};
  `.execute(db);
}
