import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { TwinModule } from '../twin/twin.module.js';
import { WorkbenchModule } from '../workbench/workbench.module.js';
import {
  BullMqExtractionQueue,
  DisabledExtractionQueue,
  EXTRACTION_QUEUE,
  type ExtractionQueue,
} from './extraction-queue.js';
import { ExtractionService, UploadEvents } from './extraction.service.js';
import { PurgeService } from './purge.service.js';
import { ReportUploadsController, ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { OBJECT_STORAGE, S3ObjectStorage, type ObjectStorage } from './storage.js';
import { ReportUploadInterceptor } from './upload.interceptor.js';

/** 测试用：替换对象存储和识别队列（不需要真实的 S3 和 Redis） */
export interface ReportInfraOverrides {
  objectStorage?: ObjectStorage | null;
  extractionQueue?: ExtractionQueue;
}
export const REPORT_INFRA_OVERRIDES = Symbol('REPORT_INFRA_OVERRIDES');

@Module({
  imports: [AiModule, WorkbenchModule, TwinModule],
  controllers: [ReportUploadsController, ReportsController],
  providers: [
    ReportsRepository,
    UploadEvents,
    ExtractionService,
    PurgeService,
    ReportUploadInterceptor,
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG, { token: REPORT_INFRA_OVERRIDES, optional: true }],
      useFactory: (config: AppConfig, overrides?: ReportInfraOverrides): ObjectStorage | null => {
        if (overrides && 'objectStorage' in overrides) return overrides.objectStorage ?? null;
        return config.storage ? new S3ObjectStorage(config.storage) : null;
      },
    },
    {
      provide: EXTRACTION_QUEUE,
      inject: [APP_CONFIG, { token: REPORT_INFRA_OVERRIDES, optional: true }],
      useFactory: (config: AppConfig, overrides?: ReportInfraOverrides): ExtractionQueue => {
        if (overrides?.extractionQueue) return overrides.extractionQueue;
        return config.redisUrl
          ? new BullMqExtractionQueue(config.redisUrl)
          : new DisabledExtractionQueue();
      },
    },
  ],
  // 对象存储也给协会品牌（Logo）用
  exports: [ReportsRepository, OBJECT_STORAGE],
})
export class ReportsModule {}
