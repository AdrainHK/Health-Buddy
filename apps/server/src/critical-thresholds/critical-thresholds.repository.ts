import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_CRITICAL_RULES,
  thresholdValueInBounds,
  type CreateCriticalThresholdRequest,
  type CriticalThreshold,
  type IndicatorCode,
  type UpdateCriticalThresholdRequest,
} from '@health-buddy/shared';
import { badRequest, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';

const COLUMNS = [
  'id',
  'metric',
  'comparator',
  'value',
  'level',
  'enabled',
  'updated_by',
  'updated_at',
] as const;

/**
 * 危急指标阈值仓储（M1 规格第五节之二）。全平台一套，只有平台管理员能改（Q12）。
 * 可读和可写范围由行级安全决定；修改记录由数据库触发器写入，这里不单独记。
 */
@Injectable()
export class CriticalThresholdsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(ctx: TenantContext): Promise<CriticalThreshold[]> {
    return withTenant(this.db, ctx, (trx) => listIn(trx));
  }

  create(ctx: TenantContext, input: CreateCriticalThresholdRequest): Promise<CriticalThreshold> {
    return this.write(ctx, async (trx) => {
      const row = await trx
        .insertInto('critical_thresholds')
        .values({
          metric: input.metric,
          comparator: input.comparator,
          value: input.value,
          level: input.level,
          enabled: input.enabled,
          updated_by: ctx.userId,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toThreshold(row);
    });
  }

  /** 找不到返回 undefined */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateCriticalThresholdRequest,
  ): Promise<CriticalThreshold | undefined> {
    return this.write(ctx, async (trx) => {
      const current = await trx
        .selectFrom('critical_thresholds')
        .select(['metric'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return undefined;
      // 修改不能换指标，范围按原指标校验
      if (
        input.value !== undefined &&
        !thresholdValueInBounds(current.metric as IndicatorCode, input.value)
      ) {
        throw badRequest();
      }
      const row = await trx
        .updateTable('critical_thresholds')
        .set({
          ...(input.comparator !== undefined ? { comparator: input.comparator } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          updated_by: ctx.userId,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .returning(COLUMNS)
        .executeTakeFirst();
      return row && toThreshold(row);
    });
  }

  /** 恢复为默认值：删掉全部规则，按参照国际标准的默认值重新写入 */
  resetToDefaults(ctx: TenantContext): Promise<CriticalThreshold[]> {
    return this.write(ctx, async (trx) => {
      await trx.deleteFrom('critical_thresholds').execute();
      await trx
        .insertInto('critical_thresholds')
        .values(DEFAULT_CRITICAL_RULES.map((r) => ({ ...r, updated_by: ctx.userId })))
        .execute();
      return listIn(trx);
    });
  }

  /** 同一指标同一方向只能有一条规则，重复时返回 409 */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      if (dbErrorCode(err) === '23505') throw conflict();
      throw err;
    }
  }
}

async function listIn(trx: TenantTransaction): Promise<CriticalThreshold[]> {
  const rows = await trx
    .selectFrom('critical_thresholds')
    .select(COLUMNS)
    .orderBy('metric')
    .orderBy('comparator')
    .execute();
  return rows.map(toThreshold);
}

function toThreshold(row: {
  id: string;
  metric: string;
  comparator: CriticalThreshold['comparator'];
  value: string;
  level: CriticalThreshold['level'];
  enabled: boolean;
  updated_by: string | null;
  updated_at: Date;
}): CriticalThreshold {
  return {
    id: row.id,
    metric: row.metric as IndicatorCode,
    comparator: row.comparator,
    value: Number(row.value),
    level: row.level,
    enabled: row.enabled,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}
