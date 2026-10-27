import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M5 第 3 步（3b）：
 * - plan_usage_stats：按协会、日期汇总 /方案生成 次数和确认数、随访计划确认数、随访完成数、未联系上数、
 *   随访记录确认数（规格 6.2 统计视图）。不含 manager_id、client_id。运营商只看本协会，平台看全部，
 *   其他角色拒绝。
 * - plan_goal_template_metrics：方案执行情况要知道目标模板关联的监测指标和参数；模板以后被停用时
 *   健管师按行级安全看不到它，执行情况就算不出来。模板不是客户数据，这个函数只返回指标相关的列，
 *   只给健管师用，并且只返回本人负责的客户的方案里引用过的模板。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  await sql`
    create function plan_usage_stats(p_from date, p_to date, p_operator_id uuid default null)
      returns table (
        operator_id uuid,
        day text,
        plans_generated int,
        plans_approved int,
        schedules_approved int,
        visits_done int,
        visits_missed int,
        records_approved int
      )
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    #variable_conflict use_column
    declare
      v_operator uuid;
      v_start timestamptz;
      v_end timestamptz;
    begin
      if app_role() = 'platform_admin' then
        v_operator := p_operator_id;
      elsif app_role() = 'operator_admin' and app_operator_id() is not null then
        -- 运营商请求别的协会也只返回本协会
        v_operator := app_operator_id();
      else
        raise exception 'plan usage stats not allowed' using errcode = 'insufficient_privilege';
      end if;
      if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
        raise exception 'invalid date range' using errcode = 'invalid_parameter_value';
      end if;
      v_start := p_from::timestamp at time zone 'UTC';
      v_end := (p_to + 1)::timestamp at time zone 'UTC';

      return query
        with x as (
          select a.operator_id, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD') as d,
                 1 as pg, 0 as pa, 0 as sa, 0 as vd, 0 as vm, 0 as ra
          from artifacts a
          where a.kind = 'care_plan' and a.version = 1
            and a.created_at >= v_start and a.created_at < v_end
            and (v_operator is null or a.operator_id = v_operator)
          union all
          select p.operator_id, to_char(p.approved_at at time zone 'UTC', 'YYYY-MM-DD'), 0, 1, 0, 0, 0, 0
          from care_plans p
          where p.approved_at >= v_start and p.approved_at < v_end
            and (v_operator is null or p.operator_id = v_operator)
          union all
          select a.operator_id, to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD'), 0, 0, 1, 0, 0, 0
          from artifact_events e join artifacts a on a.id = e.artifact_id
          where a.kind = 'visit_schedule' and e.action = 'approved'
            and e.created_at >= v_start and e.created_at < v_end
            and (v_operator is null or a.operator_id = v_operator)
          union all
          select e.operator_id, to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD'), 0, 0, 0,
                 (e.action = 'done')::int, (e.action = 'missed')::int, 0
          from visit_events e
          where e.action in ('done', 'missed')
            and e.created_at >= v_start and e.created_at < v_end
            and (v_operator is null or e.operator_id = v_operator)
          union all
          select r.operator_id, to_char(r.approved_at at time zone 'UTC', 'YYYY-MM-DD'), 0, 0, 0, 0, 0, 1
          from visit_records r
          where r.approved_at >= v_start and r.approved_at < v_end
            and (v_operator is null or r.operator_id = v_operator)
        )
        select x.operator_id, x.d, sum(pg)::int, sum(pa)::int, sum(sa)::int, sum(vd)::int,
               sum(vm)::int, sum(ra)::int
        from x
        group by x.operator_id, x.d
        order by x.d, x.operator_id;
    end
    $$;
    revoke all on function plan_usage_stats(date, date, uuid) from public;
    grant execute on function plan_usage_stats(date, date, uuid) to ${app};

    create function plan_goal_template_metrics(p_ids uuid[])
      returns table (id uuid, params jsonb, metric text, metric_param text)
      language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'manager' then
        raise exception 'managers only' using errcode = 'insufficient_privilege';
      end if;
      return query
        select g.id, g.params, g.metric, g.metric_param from plan_goal_templates g
        where g.id = any (p_ids)
          -- 只返回本人负责的客户的方案里引用过的模板（草稿、从未发布的模板查不到）
          and exists (
            select 1 from care_plans p
            where p.manager_id = app_user_id()
              and p.snapshot -> 'libraryVersions'
                  @> jsonb_build_array(jsonb_build_object('type', 'goal_template', 'id', g.id::text))
          );
    end
    $$;
    revoke all on function plan_goal_template_metrics(uuid[]) from public;
    grant execute on function plan_goal_template_metrics(uuid[]) to ${app};
  `.execute(db);
}
