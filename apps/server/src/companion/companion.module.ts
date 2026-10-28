import { Module } from '@nestjs/common';
import { CompanionAdminRepository } from './companion-admin.repository.js';
import { CompanionAdminController, CompanionController } from './companion.controller.js';
import { CompanionRepository } from './companion.repository.js';

/** AI 健康伴侣“福宝”（M6）：第 1 步是设备、同意、伴侣设置和平台固定话术 */
@Module({
  controllers: [CompanionController, CompanionAdminController],
  providers: [CompanionRepository, CompanionAdminRepository],
})
export class CompanionModule {}
