import { Inject, Injectable } from '@nestjs/common';
import type { ClientSummary } from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

/**
 * 客户数据仓储。可见范围完全由数据库的行级安全决定：
 * 健管师只看到自己服务的客户，机构管理员看到本机构的客户，运营商和平台看不到。
 */
@Injectable()
export class ClientsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(ctx: TenantContext): Promise<ClientSummary[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await selectSummary(trx)
        .orderBy('created_at')
        .orderBy('id')
        .limit(500)
        .execute();
      return rows.map(toSummary);
    });
  }

  findById(ctx: TenantContext, id: string): Promise<ClientSummary | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await selectSummary(trx).where('id', '=', id).executeTakeFirst();
      return row && toSummary(row);
    });
  }
}

function selectSummary(trx: TenantTransaction) {
  return trx
    .selectFrom('clients')
    .select(['id', 'display_name', 'gender', 'birth_year', 'manager_id', 'is_synthetic']);
}

function toSummary(row: {
  id: string;
  display_name: string;
  gender: ClientSummary['gender'];
  birth_year: number | null;
  manager_id: string;
  is_synthetic: boolean;
}): ClientSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    gender: row.gender,
    birthYear: row.birth_year,
    managerId: row.manager_id,
    isSynthetic: row.is_synthetic,
  };
}
