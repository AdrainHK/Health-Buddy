import { Global, Module } from '@nestjs/common';
import { PlanFeatureGuard } from './plan-feature.guard.js';
import { PlansController } from './plans.controller.js';
import { PlansRepository } from './plans.repository.js';
import { QuotaService } from './quota.service.js';

/** 套餐和额度（M7 第 4 步）。额度检查和功能守卫给各业务模块用，所以是全局模块 */
@Global()
@Module({
  controllers: [PlansController],
  providers: [PlansRepository, QuotaService, PlanFeatureGuard],
  exports: [QuotaService, PlanFeatureGuard],
})
export class PlansModule {}
