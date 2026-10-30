import { sql, type Kysely } from 'kysely';
import { DEFAULT_TWIN_STATUS_RULES } from '@health-buddy/shared';
import { TWIN_RULE_METRICS_SNAPSHOT } from './0016-client-twin.js';

/**
 * M6 伴侣“福宝”第 6 步（6c）：孪生新增“心理”方面和收集信息条数规则（规格 2.6、Q20、N16，验收 11）。
 *
 * - 方面加 mental：twin_status_rules、twin_status_history、follow_up_items 的方面检查。
 * - twin_status_rules：来源加 companion、判断方式加 observation_count（“近 N 天某类收集信息
 *   消极的条目达到 M 条”）。这类规则没有指标和阈值，有 category、polarity、min_count；
 *   情绪（mood）只算心理，睡眠（sleep）只算睡眠。修改记录、版本号、恢复默认值沿用 0016。
 * - 默认加两条条数规则（近 14 天消极 ≥ 3 条为黄），数值是测试值、待心理和医学顾问审定，**默认停用**。
 * - 状态历史的触发原因加 companion（收集信息写入或被驳回后重算）。
 * 行级安全不变：规则全平台一套，平台管理员可写，其余角色只读。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const DOMAINS = `'metabolic', 'cardiovascular', 'sleep', 'weight', 'mental'`;

  await sql`
    alter table twin_status_rules drop constraint twin_status_rules_domain_check;
    alter table twin_status_rules add constraint twin_status_rules_domain_check
      check (domain in (${sql.raw(DOMAINS)}));
    alter table twin_status_history drop constraint twin_status_history_domain_check;
    alter table twin_status_history add constraint twin_status_history_domain_check
      check (domain in (${sql.raw(DOMAINS)}));
    alter table follow_up_items drop constraint follow_up_items_domain_check;
    alter table follow_up_items add constraint follow_up_items_domain_check
      check (domain in (${sql.raw(DOMAINS)}));

    alter table twin_status_history drop constraint twin_status_history_trigger_check;
    alter table twin_status_history add constraint twin_status_history_trigger_check
      check (trigger in ('report_verified', 'correction', 'monitoring', 'rules_changed',
        'thresholds_changed', 'manual', 'seed', 'backfill', 'companion'));
  `.execute(db);

  // 规则表：条数规则没有指标；原有约束只管报告和监测规则
  await sql`
    do $$
    declare c text;
    begin
      select conname into c from pg_constraint
        where conrelid = 'twin_status_rules'::regclass and contype = 'u';
      execute format('alter table twin_status_rules drop constraint %I', c);
    end
    $$;
    alter table twin_status_rules
      alter column metric drop not null,
      add column category text check (category in ('mood', 'sleep')),
      add column polarity text check (polarity in ('negative')),
      add column min_count int check (min_count between 1 and 100),
      drop constraint twin_status_rules_source_check,
      add constraint twin_status_rules_source_check
        check (source in ('report', 'monitoring', 'companion')),
      drop constraint twin_status_rules_method_check,
      add constraint twin_status_rules_method_check
        check (method in ('critical', 'out_of_reference', 'threshold', 'observation_count'));

    alter table twin_status_rules drop constraint twin_status_rules_metric;
    alter table twin_status_rules add constraint twin_status_rules_metric check (
      (source = 'companion' and metric is null)
      or (source <> 'companion' and metric is not null)
    );
    alter table twin_status_rules drop constraint twin_status_rules_method_source;
    alter table twin_status_rules add constraint twin_status_rules_method_source check (
      (method <> 'out_of_reference' or source = 'report')
      and (method <> 'threshold' or source = 'monitoring')
      and ((method = 'observation_count') = (source = 'companion'))
    );
    alter table twin_status_rules drop constraint twin_status_rules_window;
    alter table twin_status_rules add constraint twin_status_rules_window
      check ((source = 'report') = (window_days is null));
    -- 条数规则必须有类别、极性和条数，类别跟着方面走；其余规则都没有
    alter table twin_status_rules add constraint twin_status_rules_observation check (
      (method = 'observation_count' and polarity is not null and min_count is not null
        and ((category = 'mood' and domain = 'mental') or (category = 'sleep' and domain = 'sleep')))
      or (method <> 'observation_count' and category is null and polarity is null
        and min_count is null)
    );
    alter table twin_status_rules add constraint twin_status_rules_unique
      unique nulls not distinct (domain, metric, source, method, comparator, level, category, polarity);
  `.execute(db);

  // 0016 的指标目录约束被上面替换成了“有无指标”，这里用触发器补回报告、监测规则的目录校验
  await sql`
    create function twin_status_rules_catalog_guard() returns trigger language plpgsql as $$
    begin
      if new.source <> 'companion' and not exists (
        select 1 from (values ${sql.raw(catalogTuples())}) as t(domain, source, metric)
        where t.domain = new.domain and t.source = new.source and t.metric = new.metric
      ) then
        raise exception 'metric not in domain' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    create trigger twin_status_rules_catalog_guard before insert or update on twin_status_rules
      for each row execute function twin_status_rules_catalog_guard();
  `.execute(db);

  // 修改记录带上新列；恢复默认值支持停用的规则和条数规则
  await sql`
    create or replace function twin_status_rules_audit() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    declare
      rule_fields text[] := array['domain', 'metric', 'source', 'method', 'comparator', 'value',
                                  'unit', 'window_days', 'level', 'enabled', 'category',
                                  'polarity', 'min_count'];
      b jsonb;
      a jsonb;
      v int;
    begin
      update twin_rules_version
        set version = version + 1, updated_at = now(), bumped_xact = pg_current_xact_id()
        where bumped_xact is distinct from pg_current_xact_id();
      select version into v from twin_rules_version;
      if tg_op <> 'INSERT' then
        select jsonb_object_agg(k, x) into b from jsonb_each(to_jsonb(old)) as e(k, x)
          where k = any (rule_fields);
      end if;
      if tg_op <> 'DELETE' then
        select jsonb_object_agg(k, x) into a from jsonb_each(to_jsonb(new)) as e(k, x)
          where k = any (rule_fields);
      end if;
      insert into twin_status_rule_events (rule_id, actor_id, action, before, after, rules_version)
        values (
          coalesce(new.id, old.id),
          app_user_id(),
          case
            when exists (
              select 1 from twin_rules_reset_marker m where m.xact = pg_current_xact_id()
            ) then 'reset'
            when tg_op = 'INSERT' then 'created'
            when tg_op = 'UPDATE' then 'updated'
            else 'deleted'
          end,
          b,
          a,
          v
        );
      return coalesce(new, old);
    end
    $$;

    create or replace function twin_status_rules_reset(p_rules jsonb) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
    as $$
    begin
      if app_role() is distinct from 'platform_admin' or app_user_id() is null then
        raise exception 'only the platform admin can reset rules' using errcode = 'insufficient_privilege';
      end if;
      if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) = 0 then
        raise exception 'reset needs a non-empty rule list' using errcode = 'invalid_parameter_value';
      end if;
      insert into twin_rules_reset_marker (xact) values (pg_current_xact_id())
        on conflict do nothing;
      delete from twin_status_rules;
      insert into twin_status_rules
        (domain, metric, source, method, comparator, value, unit, window_days, level, enabled,
         category, polarity, min_count, updated_by)
        select r.domain, r.metric, r.source, r.method, r.comparator, r.value, r.unit,
               r.window_days, r.level, coalesce(r.enabled, true), r.category, r.polarity,
               r.min_count, app_user_id()
        from jsonb_to_recordset(p_rules) as r(domain text, metric text, source text, method text,
          comparator text, value numeric, unit text, window_days int, level text, enabled boolean,
          category text, polarity text, min_count int);
      delete from twin_rules_reset_marker where xact = pg_current_xact_id();
    end
    $$;
  `.execute(db);

  // 两条默认的条数规则（停用）。经审计触发器写入，版本号加一、有修改记录
  for (const r of DEFAULT_TWIN_STATUS_RULES.filter((x) => x.method === 'observation_count')) {
    await sql`
      insert into twin_status_rules
        (domain, metric, source, method, window_days, level, enabled, category, polarity, min_count)
      values (${r.domain}, null, ${r.source}, ${r.method}, ${r.windowDays}, ${r.level},
              ${r.enabled ?? true}, ${r.category}, ${r.polarity}, ${r.minCount})
    `.execute(db);
  }
}

/** 报告、监测规则的方面、来源、指标：沿用 0016 的目录快照（不随 packages/shared 变化） */
function catalogTuples(): string {
  return TWIN_RULE_METRICS_SNAPSHOT.map(([d, s, m]) => `('${d}', '${s}', '${m}')`).join(', ');
}
