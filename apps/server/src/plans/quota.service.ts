import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { PlanFeature } from '@health-buddy/shared';
import { ApiException } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';
import {
  planFeatureEnabled,
  quotaCompanionDeviceOk,
  quotaConsume,
  type MeteredQuota,
} from '../db/plans.js';

export const quotaExceeded = (metric: string) =>
  new ApiException(HttpStatus.TOO_MANY_REQUESTS, 'quota_exceeded', { metric });
export const planFeatureDisabled = (feature: PlanFeature) =>
  new ApiException(HttpStatus.FORBIDDEN, 'plan_feature_disabled', { feature });

/**
 * 套餐额度和功能开关（M7 规格 2.5）。在调用模型之前检查（规格 7.1）：超额抛 429 quota_exceeded，
 * 不调用模型。只计健管师本人；危机、急症传 bypass，照常记数、不拦截（红线 4）。
 * 额度在 M1–M6 的技术性上限之外再加一层，技术性上限不动。
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async consume(
    ctx: TenantContext,
    metric: MeteredQuota,
    n = 1,
    opts: { bypass?: boolean } = {},
  ): Promise<void> {
    if (ctx.role !== 'manager' || n <= 0) return;
    const ok = await withTenant(this.db, ctx, (trx) =>
      quotaConsume(trx, metric, n, opts.bypass ?? false),
    );
    if (!ok) throw quotaExceeded(metric);
  }

  /** 健管师的套餐是否包含这个功能；其他角色不受套餐限制 */
  async featureEnabled(ctx: TenantContext, feature: PlanFeature): Promise<boolean> {
    if (ctx.role !== 'manager') return true;
    return withTenant(this.db, ctx, (trx) => planFeatureEnabled(trx, feature));
  }

  async companionDeviceOk(ctx: TenantContext): Promise<boolean> {
    if (ctx.role !== 'manager') return true;
    return withTenant(this.db, ctx, (trx) => quotaCompanionDeviceOk(trx));
  }
}
