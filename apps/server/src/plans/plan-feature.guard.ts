import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlanFeature } from '@health-buddy/shared';
import type { AuthedRequest } from '../auth/decorators.js';
import { planFeatureDisabled, QuotaService } from './quota.service.js';

const PLAN_FEATURE = 'hb:plan-feature';

/** 控制器或方法所属的套餐功能（M7 规格 2.5 第 4 条）；和 PlanFeatureGuard 一起用 */
export const RequiresFeature = (feature: PlanFeature) => SetMetadata(PLAN_FEATURE, feature);

/**
 * 套餐里没有这个功能时，健管师的写操作（非 GET）返回 403 plan_feature_disabled。
 * 只读请求照常放行：已有的数据仍可查看（规格 2.5 第 4 条）。其他角色不受套餐限制。
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly quota: QuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(PLAN_FEATURE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    const session = req.session;
    if (!session || session.role !== 'manager') return true;
    if (!(await this.quota.featureEnabled(session, feature))) throw planFeatureDisabled(feature);
    return true;
  }
}
