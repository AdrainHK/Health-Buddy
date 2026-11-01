import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M7 第 5 步：运营看板 ops_dashboard（规格 2.6、6.4，Q13–Q15）。
 *
 * 只返回按协会、机构汇总的数字，不返回 client_id、manager_id、任何文字和健康数值。
 * 运营商和平台对客户明细表没有策略，统计只经这个 SECURITY DEFINER 函数（同 expert_usage_stats）：
 * - 范围由函数按会话决定：平台看全部（可按协会筛选）；运营商管理员只看本协会（传别的协会也只返回本协会）；
 *   机构管理员只看本机构；其他角色拒绝。函数里再查一次调用者账号在用（同 admin_require_*）。
 * - 大模型用量按调用者当前所在的机构归组（不给 llm_usage 加 org_id：现在不能改机构，归组结果一样）。
 * - 估算成本只返回给平台（Q14）；孪生打开次数只有协会粒度（twin_usage_daily）。
 * - 小样本保护（Q15）在服务器端按返回的人数合并，这里给出每组的健管师数和客户数。
 * 日期按 UTC 自然日，范围不超过 92 天。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);

  await sql`
    create function ops_dashboard(p_from date, p_to date, p_operator uuid default null)
      returns jsonb
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      v_role text := app_role();
      v_operator uuid;
      v_org uuid;
      v_start timestamptz;
      v_end timestamptz;
      v_groups jsonb;
      v_skills jsonb;
      v_twin jsonb;
    begin
      if v_role = 'platform_admin' then
        perform admin_require_platform();
        v_operator := p_operator;
      elsif v_role = 'operator_admin' then
        v_operator := admin_require_operator();
      elsif v_role = 'org_admin' and app_org_id() is not null and app_operator_id() is not null then
        -- 协会、机构都从账号本身取，并要求和会话一致（租户审查 S2）
        select u.operator_id, u.org_id into v_operator, v_org
          from users u join operators o on o.id = u.operator_id
          where u.id = app_user_id() and u.role = 'org_admin' and u.status = 'active'
            and u.org_id = app_org_id() and u.operator_id = app_operator_id()
            and o.status = 'active';
        if v_org is null then
          raise exception 'ops dashboard not allowed' using errcode = '42501';
        end if;
      else
        raise exception 'ops dashboard not allowed' using errcode = '42501';
      end if;
      if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
        raise exception 'invalid date range' using errcode = 'invalid_parameter_value';
      end if;
      v_start := p_from::timestamp at time zone 'UTC';
      v_end := (p_to + 1)::timestamp at time zone 'UTC';

      with m as (
        -- 范围内的健管师（按当前协会、机构归组）
        select u.id, u.operator_id, u.org_id, u.status from users u
        where u.role = 'manager' and u.operator_id is not null
          and (v_operator is null or u.operator_id = v_operator)
          and (v_org is null or u.org_id = v_org)
      ), g as (
        select distinct operator_id, org_id from m
      ), agg as (
        select g.operator_id, g.org_id,
          (select count(*) from m where m.operator_id = g.operator_id
            and m.org_id is not distinct from g.org_id and m.status in ('pending', 'active')) as managers_opened,
          (select count(*) from m where m.operator_id = g.operator_id
            and m.org_id is not distinct from g.org_id and m.status = 'active') as managers_active,
          (select count(distinct l.user_id) from llm_usage l join m on m.id = l.user_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and l.created_at >= v_start and l.created_at < v_end) as managers_engaged,
          (select count(*) from clients c join m on m.id = c.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id) as clients_total,
          (select count(*) from clients c join m on m.id = c.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and c.created_at >= v_start and c.created_at < v_end) as clients_new,
          (select count(*) from artifacts a join m on m.id = a.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and a.created_at >= v_start and a.created_at < v_end) as artifacts,
          (select count(*) from expert_calls e join m on m.id = e.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and e.started_at >= v_start and e.started_at < v_end) as expert_calls,
          (select count(*) from care_plans p join m on m.id = p.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and p.approved_at >= v_start and p.approved_at < v_end) as care_plans,
          (select count(*) from visits v join m on m.id = v.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and v.status = 'done' and v.done_at >= v_start and v.done_at < v_end) as visits_done,
          (select count(*) from companion_devices d join m on m.id = d.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and d.client_id is not null) as companion_bound,
          (select count(distinct s.device_id) from companion_sessions s
            join companion_devices d on d.id = s.device_id join m on m.id = d.manager_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and s.started_at >= v_start and s.started_at < v_end) as companion_active,
          (select count(*) from llm_usage l join m on m.id = l.user_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and l.created_at >= v_start and l.created_at < v_end) as llm_calls,
          (select coalesce(sum(l.cost_usd), 0) from llm_usage l join m on m.id = l.user_id
            where m.operator_id = g.operator_id and m.org_id is not distinct from g.org_id
              and l.created_at >= v_start and l.created_at < v_end) as cost_usd
        from g
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'operator_id', operator_id, 'org_id', org_id,
          'managers_opened', managers_opened, 'managers_active', managers_active,
          'managers_engaged', managers_engaged, 'clients_total', clients_total,
          'clients_new', clients_new, 'artifacts', artifacts, 'expert_calls', expert_calls,
          'care_plans', care_plans, 'visits_done', visits_done,
          'companion_bound', companion_bound, 'companion_active', companion_active,
          'llm_calls', llm_calls,
          -- 估算成本是平台的经营数据（Q14）
          'cost_usd', case when v_role = 'platform_admin' then cost_usd end)), '[]'::jsonb)
        into v_groups from agg;

      -- 各技能产物数：只有技能 id 和次数（协会合计，不按机构分）
      select coalesce(jsonb_agg(jsonb_build_object('operator_id', operator_id,
          'skill_id', skill_id, 'n', n)), '[]'::jsonb) into v_skills
      from (
        select a.operator_id, a.skill_id, count(*) as n from artifacts a
        join users u on u.id = a.manager_id
        where (v_operator is null or a.operator_id = v_operator)
          and (v_org is null or u.org_id = v_org)
          and a.created_at >= v_start and a.created_at < v_end
        group by a.operator_id, a.skill_id
      ) s;

      -- 孪生打开次数（只有协会粒度；机构管理员看不到协会的数，返回空）
      select coalesce(jsonb_agg(jsonb_build_object('operator_id', operator_id, 'n', n)),
          '[]'::jsonb) into v_twin
      from (
        select t.operator_id, sum(t.opens) as n from twin_usage_daily t
        where v_org is null and (v_operator is null or t.operator_id = v_operator)
          and t.day between p_from and p_to
        group by t.operator_id
      ) s;

      return jsonb_build_object('groups', v_groups, 'skills', v_skills, 'twin_opens', v_twin);
    end
    $$;
  `.execute(db);
  await sql`revoke all on function ops_dashboard(date, date, uuid) from public`.execute(db);
  await sql`grant execute on function ops_dashboard(date, date, uuid) to ${app}`.execute(db);
}
