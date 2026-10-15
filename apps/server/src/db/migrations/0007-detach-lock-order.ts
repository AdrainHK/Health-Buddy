import { sql, type Kysely } from 'kysely';

/**
 * 客户转出或删除时，先锁住相关任务再作废草稿（Q11）。
 *
 * 应用写产物前会先给任务加共享锁（见 artifacts.repository.ts），这里先加排他锁，
 * 两边按“先任务、后产物”的顺序串行：转出不会漏掉并发生成的草稿，
 * 并发的写入也会在任务断开后看到只读状态。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create or replace function detach_client_work(p_client_id uuid, p_reason text) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      perform 1 from tasks t where t.client_id = p_client_id order by t.id for update;

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
  `.execute(db);
}
