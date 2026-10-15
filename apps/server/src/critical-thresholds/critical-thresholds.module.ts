import { Module } from '@nestjs/common';
import { CriticalThresholdsController } from './critical-thresholds.controller.js';
import { CriticalThresholdsRepository } from './critical-thresholds.repository.js';

@Module({
  controllers: [CriticalThresholdsController],
  providers: [CriticalThresholdsRepository],
  exports: [CriticalThresholdsRepository],
})
export class CriticalThresholdsModule {}
