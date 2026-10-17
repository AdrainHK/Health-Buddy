import { sql, type Kysely } from 'kysely';
import { APP_DB_ROLE } from '../../config.js';

/**
 * M2 验收反馈（产品负责人决定“固定提醒，人工看”）：确认核对前，健管师必须勾选
 * “请确认报告上的姓名是本客户”。系统不读取、不提取、不保存报告上的姓名，
 * 这里只记下是谁、什么时候做了这项确认。
 *
 * - report_uploads 加 identity_confirmed_by、identity_confirmed_at。
 * - 触发器：只能在 needs_review → verified 这一次更新里由当前用户写入（时间由数据库填）；
 *   从这次迁移起，新的确认核对必须带上这项确认。迁移前已核对的记录保持为空。
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const app = sql.id(APP_DB_ROLE);
  await sql`
    alter table report_uploads
      add column identity_confirmed_by uuid references users (id),
      add column identity_confirmed_at timestamptz,
      add constraint report_uploads_identity_confirmed check (
        (identity_confirmed_by is null) = (identity_confirmed_at is null)
      );

    create function report_uploads_identity_guard() returns trigger language plpgsql as $$
    begin
      if hb_is_system(tg_relid) then
        return new;
      end if;
      if tg_op = 'INSERT' then
        if new.identity_confirmed_by is not null or new.identity_confirmed_at is not null then
          raise exception 'identity is confirmed only on verification' using errcode = 'check_violation';
        end if;
        return new;
      end if;
      if old.status = 'needs_review' and new.status = 'verified' then
        if new.identity_confirmed_by is distinct from app_user_id() then
          raise exception 'verification must confirm the client identity' using errcode = 'check_violation';
        end if;
        new.identity_confirmed_at := now();
      elsif new.identity_confirmed_by is distinct from old.identity_confirmed_by
        or new.identity_confirmed_at is distinct from old.identity_confirmed_at
      then
        raise exception 'identity is confirmed only on verification' using errcode = 'check_violation';
      end if;
      return new;
    end
    $$;
    -- 名字排在 report_uploads_guard 之后：状态机先校验
    create trigger report_uploads_identity_guard before insert or update on report_uploads
      for each row execute function report_uploads_identity_guard();

    grant update (identity_confirmed_by) on report_uploads to ${app};
  `.execute(db);
}
