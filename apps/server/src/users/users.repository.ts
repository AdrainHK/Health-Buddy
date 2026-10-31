import { Inject, Injectable } from '@nestjs/common';
import { brandLogoPath, type CurrentUser } from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { dbErrorCode } from '../common/db-error.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';
import { userSetTimezone } from '../db/twin-functions.js';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 当前登录用户的资料。按行级安全，用户总能看到自己和所属运营商。 */
  async findCurrent(ctx: TenantContext): Promise<CurrentUser | undefined> {
    const row = await withTenant(this.db, ctx, (trx) =>
      trx
        .selectFrom('users')
        .leftJoin('operators', 'operators.id', 'users.operator_id')
        .leftJoin('operator_brands', 'operator_brands.operator_id', 'users.operator_id')
        .select([
          'users.id',
          'users.email',
          'users.display_name',
          'users.role',
          'users.org_id',
          'operators.id as operator_id',
          'operators.name as operator_name',
          'operators.brand_color',
          'operators.slug',
          'operator_brands.display_name as brand_name',
          'operator_brands.logo_updated_at',
        ])
        .where('users.id', '=', ctx.userId)
        .executeTakeFirst(),
    );
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      operator:
        row.operator_id && row.operator_name
          ? {
              id: row.operator_id,
              name: row.operator_name,
              brandColor: row.brand_color,
              brandName: row.brand_name,
              logoUrl:
                row.slug && row.logo_updated_at
                  ? brandLogoPath(row.slug, row.logo_updated_at)
                  : null,
            }
          : null,
      orgId: row.org_id,
    };
  }

  /** 改自己的时区（null 为不设置）。时区名数据库不认识时返回 false */
  async setTimeZone(ctx: TenantContext, tz: string | null): Promise<boolean> {
    try {
      await withTenant(this.db, ctx, (trx) => userSetTimezone(trx, tz));
      return true;
    } catch (err) {
      if (dbErrorCode(err) === '22023') return false;
      throw err;
    }
  }
}
