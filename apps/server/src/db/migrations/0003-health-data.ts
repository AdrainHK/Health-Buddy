import { sql, type Kysely } from 'kysely';

/**
 * 体检报告（结构化指标）和日常监测数据。M0 只建最小结构供合成数据使用，M2、M4 再扩展。
 *
 * 可见范围完全跟随客户：策略里用 exists 查 clients，而 clients 本身受行级安全约束，
 * 所以“能看到这位客户”就是“能看到他的报告和监测数据”，规则只写一处。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table health_reports (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade,
      report_date date not null,
      title text not null,
      source text not null check (source in ('synthetic', 'upload', 'manual')),
      created_at timestamptz not null default now(),
      unique (id, client_id)
    );
    create index health_reports_client_idx on health_reports (client_id, report_date);

    create table report_indicators (
      id uuid primary key default gen_random_uuid(),
      report_id uuid not null,
      client_id uuid not null,
      code text not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
      value numeric(12, 3) not null,
      unit text not null,
      -- 指标必须属于同一位客户的报告
      foreign key (report_id, client_id) references health_reports (id, client_id) on delete cascade,
      unique (report_id, code)
    );
    create index report_indicators_client_idx on report_indicators (client_id, code);

    create table monitoring_readings (
      id bigint generated always as identity primary key,
      client_id uuid not null references clients (id) on delete cascade,
      metric text not null check (metric ~ '^[a-z][a-z0-9_]{1,40}$'),
      value numeric(12, 3) not null,
      unit text not null,
      measured_at timestamptz not null,
      source text not null check (source in ('synthetic', 'device', 'manual', 'companion'))
    );
    create index monitoring_readings_client_idx on monitoring_readings (client_id, metric, measured_at);
  `.execute(db);

  for (const table of ['health_reports', 'report_indicators', 'monitoring_readings']) {
    // 列名带上表名：以后 clients 若加了同名列，子查询也不会悄悄改成比较 clients 自己的列
    const col = sql.ref(`${table}.client_id`);
    await sql`
      alter table ${sql.table(table)} enable row level security;
      create policy ${sql.id(`${table}_select`)} on ${sql.table(table)} for select using (
        exists (select 1 from clients c where c.id = ${col})
      );
      create policy ${sql.id(`${table}_write`)} on ${sql.table(table)} for all
        using (exists (select 1 from clients c where c.id = ${col} and c.manager_id = app_user_id()))
        with check (exists (select 1 from clients c where c.id = ${col} and c.manager_id = app_user_id()));
      grant select, insert, update, delete on ${sql.table(table)} to hb_app;
    `.execute(db);
  }
}
