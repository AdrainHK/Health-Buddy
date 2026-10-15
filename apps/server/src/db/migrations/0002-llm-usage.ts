import { sql, type Kysely } from 'kysely';

/**
 * 大模型调用计量。只记录用途、厂商、型号、token 数、费用估算和耗时，不存提示词和回答原文。
 * 平台看全部，运营商看本协会，个人看自己的；写入只能以当前用户的身份写。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table llm_usage (
      id bigint generated always as identity primary key,
      operator_id uuid references operators (id),
      user_id uuid not null references users (id),
      route text not null,
      provider text not null check (provider in ('openai', 'anthropic')),
      model text not null,
      input_tokens int not null check (input_tokens >= 0),
      output_tokens int not null check (output_tokens >= 0),
      cost_usd numeric(12, 6),
      duration_ms int not null check (duration_ms >= 0),
      outcome text not null check (outcome in ('complete', 'truncated', 'refused', 'error')),
      error_type text,
      created_at timestamptz not null default now()
    );
    create index llm_usage_operator_time_idx on llm_usage (operator_id, created_at);
    create index llm_usage_user_time_idx on llm_usage (user_id, created_at);

    alter table llm_usage enable row level security;

    create policy llm_usage_select on llm_usage for select using (
      app_role() = 'platform_admin'
      or (app_role() = 'operator_admin' and operator_id = app_operator_id())
      or user_id = app_user_id()
    );
    create policy llm_usage_insert on llm_usage for insert with check (
      user_id = app_user_id() and operator_id is not distinct from app_operator_id()
    );

    grant select, insert on llm_usage to hb_app;
  `.execute(db);
}
