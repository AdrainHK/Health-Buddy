import { Module } from '@nestjs/common';
import { PlanLibraryController } from './plan-library.controller.js';
import { PlanLibraryRepository } from './plan-library.repository.js';
import { VisitFrequencyController } from './visit-frequency.controller.js';
import { VisitFrequencyRepository } from './visit-frequency.repository.js';

/** 方案库和随访频次规则（M5 第 2 步）：平台级数据，后台维护 */
@Module({
  controllers: [PlanLibraryController, VisitFrequencyController],
  providers: [PlanLibraryRepository, VisitFrequencyRepository],
  exports: [PlanLibraryRepository, VisitFrequencyRepository],
})
export class PlanLibraryModule {}
