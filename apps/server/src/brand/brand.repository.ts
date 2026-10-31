import { Inject, Injectable } from '@nestjs/common';
import { brandLogoPath, type Brand, type UpdateBrandRequest } from '@health-buddy/shared';
import {
  adminSetBrandLogo,
  adminUpdateBrand,
  publicBrand,
  type PublicBrandRow,
} from '../db/brand.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

/**
 * 协会品牌（M7 规格 2.2、2.3）。读本协会的走行级安全；写只调数据库函数（协会由会话决定）。
 */
@Injectable()
export class BrandRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(ctx: TenantContext): Promise<Brand | undefined> {
    return withTenant(this.db, ctx, (trx) => this.brandIn(trx, ctx.operatorId!));
  }

  update(ctx: TenantContext, v: UpdateBrandRequest): Promise<Brand | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      await adminUpdateBrand(trx, v);
      return this.brandIn(trx, ctx.operatorId!);
    });
  }

  /** 换 Logo，返回新品牌和旧的对象 key（调用方删除旧文件） */
  setLogo(
    ctx: TenantContext,
    key: string,
    type: string,
  ): Promise<{ brand: Brand | undefined; oldKey: string | null }> {
    return withTenant(this.db, ctx, async (trx) => {
      const oldKey = await adminSetBrandLogo(trx, key, type);
      return { brand: await this.brandIn(trx, ctx.operatorId!), oldKey };
    });
  }

  publicBrand(slug: string): Promise<PublicBrandRow | undefined> {
    return publicBrand(this.db, slug);
  }

  private async brandIn(trx: TenantTransaction, operatorId: string): Promise<Brand | undefined> {
    const row = await trx
      .selectFrom('operators')
      .leftJoin('operator_brands', 'operator_brands.operator_id', 'operators.id')
      .select([
        'operators.name',
        'operators.slug',
        'operators.brand_color',
        'operator_brands.display_name',
        'operator_brands.login_greeting',
        'operator_brands.logo_updated_at',
        'operator_brands.updated_at',
      ])
      .where('operators.id', '=', operatorId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      operatorName: row.name,
      displayName: row.display_name,
      primaryColor: row.brand_color,
      loginGreeting: row.login_greeting,
      logoUrl: row.logo_updated_at ? brandLogoPath(row.slug, row.logo_updated_at) : null,
      updatedAt: row.updated_at?.toISOString() ?? null,
    };
  }
}
