import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * 专家调用统计 expert_usage_stats（M3 规格 6.2、6.4，验收第 25 条）。
 *
 * 运营商和平台管理员对专家明细表（expert_calls、expert_feedback）没有任何策略（Q10），
 * 统计只通过这个 SECURITY DEFINER 函数提供，不给这两个角色开明细表的策略：
 * - 只返回按协会、专家、日期（UTC 自然日）汇总的数字：调用次数、成功、超时、token、费用估算、有用/没用。
 *   不返回 manager_id、client_id、task_id，也不返回意见内容。
 * - 范围由函数自己按租户上下文决定：运营商只能看本协会（传别的协会也只返回本协会）；
 *   平台管理员看全部，可以按协会筛选；其他角色和没有上下文的连接直接拒绝。
 * - 费用估算取 llm_usage.cost_usd（模型网关计量时按 packages/ai-engine 的价目表算出），
 *   只算带 expert_id 的计量行；路由和汇总不归属到某位专家，不计入。
 * - 只统计已结束的调用（进行中的不计），成功率的分母不会被正在进行的调用拉低。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function expert_usage_stats(p_from date, p_to date, p_operator_id uuid default null)
      returns table (
        operator_id uuid,
        expert_id text,
        day text,
        calls int,
        succeeded int,
        timed_out int,
        input_tokens bigint,
        output_tokens bigint,
        cost_usd numeric,
        useful int,
        not_useful int
      )
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    -- 输出列和表的列同名（operator_id、expert_id 等），查询里一律指表的列
    #variable_conflict use_column
    declare
      v_operator uuid;
      v_start timestamptz;
      v_end timestamptz;
    begin
      if app_role() = 'platform_admin' then
        v_operator := p_operator_id;
      elsif app_role() = 'operator_admin' and app_operator_id() is not null then
        -- 运营商请求别的协会也只返回本协会（规格 6.4）
        v_operator := app_operator_id();
      else
        raise exception 'expert usage stats not allowed' using errcode = 'insufficient_privilege';
      end if;
      if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
        raise exception 'invalid date range' using errcode = 'invalid_parameter_value';
      end if;
      v_start := p_from::timestamp at time zone 'UTC';
      v_end := (p_to + 1)::timestamp at time zone 'UTC';

      return query
        with c as (
          select e.id, e.operator_id, e.expert_id, e.status,
                 e.input_tokens, e.output_tokens,
                 to_char(e.started_at at time zone 'UTC', 'YYYY-MM-DD') as day
          from expert_calls e
          where e.started_at >= v_start and e.started_at < v_end
            and e.status <> 'running'
            and (v_operator is null or e.operator_id = v_operator)
        ),
        f as (
          select c.operator_id, c.expert_id, c.day,
                 count(*) filter (where fb.rating = 'useful')::int as useful,
                 count(*) filter (where fb.rating = 'not_useful')::int as not_useful
          from expert_feedback fb join c on c.id = fb.expert_call_id
          group by 1, 2, 3
        ),
        u as (
          select l.operator_id, l.expert_id,
                 to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
                 sum(l.cost_usd) as cost_usd
          from llm_usage l
          where l.expert_id is not null
            and l.created_at >= v_start and l.created_at < v_end
            and (v_operator is null or l.operator_id = v_operator)
          group by 1, 2, 3
        ),
        s as (
          select c.operator_id, c.expert_id, c.day,
                 count(*)::int as calls,
                 count(*) filter (where c.status = 'done')::int as succeeded,
                 count(*) filter (where c.status = 'timeout')::int as timed_out,
                 sum(c.input_tokens)::bigint as input_tokens,
                 sum(c.output_tokens)::bigint as output_tokens
          from c
          group by 1, 2, 3
        )
        select s.operator_id, s.expert_id, s.day, s.calls, s.succeeded, s.timed_out,
               s.input_tokens, s.output_tokens, coalesce(u.cost_usd, 0),
               coalesce(f.useful, 0), coalesce(f.not_useful, 0)
        from s
          left join f using (operator_id, expert_id, day)
          left join u using (operator_id, expert_id, day)
        order by s.day, s.operator_id, s.expert_id;
    end
    $$;
    revoke all on function expert_usage_stats(date, date, uuid) from public;
  `.execute(db);

  const app = sql.id(APP_DB_ROLE);
  await sql`
    grant execute on function expert_usage_stats(date, date, uuid) to ${app};
  `.execute(db);
}
