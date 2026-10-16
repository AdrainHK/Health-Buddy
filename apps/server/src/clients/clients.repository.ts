import { Inject, Injectable } from '@nestjs/common';
import type { ClientSummary, CreateClientRequest, UpdateClientRequest } from '@health-buddy/shared';
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
      const rows = await selectClientSummary(trx)
        .orderBy('created_at')
        .orderBy('id')
        .limit(500)
        .execute();
      return rows.map(toClientSummary);
    });
  }

  findById(ctx: TenantContext, id: string): Promise<ClientSummary | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await selectClientSummary(trx).where('id', '=', id).executeTakeFirst();
      return row && toClientSummary(row);
    });
  }

  /**
   * 新建客户（Q13）。租户字段只取自当前会话，客户只能建在自己名下；
   * 健管师手动新建的是真实客户，不带合成数据标记。
   */
  create(ctx: TenantContext, input: CreateClientRequest): Promise<ClientSummary> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('clients')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          display_name: input.displayName,
          gender: input.gender ?? null,
          birth_year: input.birthYear ?? null,
          is_synthetic: false,
        })
        .returning(SUMMARY_COLUMNS)
        .executeTakeFirstOrThrow();
      return toClientSummary(row);
    });
  }

  /** 修改称呼、性别、出生年份。不是自己的客户时返回 undefined */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateClientRequest,
  ): Promise<ClientSummary | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .updateTable('clients')
        .set({
          ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
          ...(input.gender !== undefined ? { gender: input.gender } : {}),
          ...(input.birthYear !== undefined ? { birth_year: input.birthYear } : {}),
        })
        .where('id', '=', id)
        .where('manager_id', '=', ctx.userId)
        .returning(SUMMARY_COLUMNS)
        .executeTakeFirst();
      return row && toClientSummary(row);
    });
  }
}

const SUMMARY_COLUMNS = [
  'id',
  'display_name',
  'gender',
  'birth_year',
  'manager_id',
  'is_synthetic',
] as const;

export function selectClientSummary(trx: TenantTransaction) {
  return trx.selectFrom('clients').select(SUMMARY_COLUMNS);
}

export function toClientSummary(row: {
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
