import { Module } from '@nestjs/common';
import { CareController } from './care.controller.js';
import { CarePlansRepository } from './care-plans.repository.js';
import { MaterialPurgeService } from './material-purge.service.js';
import { VisitMaterialsRepository } from './visit-materials.repository.js';
import { VisitRecordsRepository } from './visit-records.repository.js';
import { VisitsRepository } from './visits.repository.js';

/** 方案和随访（M5 第 3 步）：只给服务客户的健管师 */
@Module({
  controllers: [CareController],
  providers: [
    CarePlansRepository,
    VisitsRepository,
    VisitMaterialsRepository,
    VisitRecordsRepository,
    MaterialPurgeService,
  ],
  exports: [CarePlansRepository, VisitsRepository, VisitMaterialsRepository, MaterialPurgeService],
})
export class CareModule {}
