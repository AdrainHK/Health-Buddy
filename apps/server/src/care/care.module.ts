import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { WorkbenchModule } from '../workbench/workbench.module.js';
import { CareController } from './care.controller.js';
import { CarePlansRepository } from './care-plans.repository.js';
import { ChatTranscriptionService } from './chat-transcription.service.js';
import { MaterialPurgeService } from './material-purge.service.js';
import { ScreenshotUploadInterceptor } from './screenshot-upload.interceptor.js';
import { VisitMaterialsRepository } from './visit-materials.repository.js';
import { VisitRecordsRepository } from './visit-records.repository.js';
import { VisitsRepository } from './visits.repository.js';

/** 方案和随访（M5 第 3 步）：只给服务客户的健管师 */
@Module({
  imports: [AiModule, WorkbenchModule],
  controllers: [CareController],
  providers: [
    CarePlansRepository,
    VisitsRepository,
    VisitMaterialsRepository,
    VisitRecordsRepository,
    MaterialPurgeService,
    ChatTranscriptionService,
    ScreenshotUploadInterceptor,
  ],
  exports: [CarePlansRepository, VisitsRepository, VisitMaterialsRepository, MaterialPurgeService],
})
export class CareModule {}
