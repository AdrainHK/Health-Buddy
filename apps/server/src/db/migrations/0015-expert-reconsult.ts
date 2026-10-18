import { sql, type Kysely } from 'kysely';

/**
 * M3 重新请专家、补请专家和 10 分钟内复用意见（规格 2.5、2.6、3.7、6.4）。
 *
 * - expert_consultations.origin_id / origin_kind：这次调用由哪次调用派生（reconsult 重新请专家、
 *   add_expert 补请因数量上限没请的专家）。复合外键 (origin_id, task_id) 保证原调用属于同一任务，
 *   也就属于同一位健管师；两列要么都为空，要么都有值。原调用不变（终态后不可修改的规则不变）。
 * - request_message_id：这次调用回答的那条健管师消息（问题原文只在 task_messages 里，不复制）。
 *   复合外键保证消息属于同一任务。重新请专家时按这条消息的原文再问一次；10 分钟内复用意见时
 *   比较原文是否相同。
 * - request_key：请求里和专家有关的部分（直接请还是自动选择、指定、排除、绑定的专家），只有专家 id，
 *   不含任何客户资料和问题原文。
 * - task_steps.label_time：步骤文案里的时间（“沿用 10:32 的专家意见”）。
 * - task_steps.consultation_id：10 分钟内沿用上次意见的步骤指向被沿用的调用记录，刷新后对话区据此
 *   恢复危机、急症的置顶提示（规格 7.2 第 5 条：提示不依赖回答正文）。触发器（调用者权限，受行级安全约束）
 *   保证被引用的调用和这一步属于同一任务。
 *
 * 新列都在插入时写好，之后和其他列一样不可修改（0012、0013 的触发器按整行比较，新列自动包含在内）。
 * 行级安全、授权不变：expert_consultations 和 task_steps 的 insert 是整表授权，update 没有开放新列。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table expert_consultations
      add column origin_id uuid,
      add column origin_kind text check (origin_kind in ('reconsult', 'add_expert')),
      add column request_message_id uuid,
      add column request_key text check (length(request_key) <= 1000),
      add constraint expert_consultations_origin check ((origin_id is null) = (origin_kind is null)),
      add foreign key (origin_id, task_id) references expert_consultations (id, task_id),
      add foreign key (request_message_id, task_id) references task_messages (id, task_id);
    create index expert_consultations_origin_idx on expert_consultations (origin_id);

    alter table task_steps
      add column label_time timestamptz,
      add column consultation_id uuid references expert_consultations (id);

    create function task_steps_consultation_guard() returns trigger language plpgsql as $$
    begin
      if new.consultation_id is not null and not exists (
        select 1
        from expert_consultations c
        join task_messages m on m.task_id = c.task_id
        where c.id = new.consultation_id and m.id = new.message_id
      ) then
        raise exception 'step can only reference a consultation of the same task'
          using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger task_steps_consultation_guard before insert or update on task_steps
      for each row execute function task_steps_consultation_guard();
  `.execute(db);
}
