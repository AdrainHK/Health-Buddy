import { Module } from '@nestjs/common';
import { TwinModule } from '../twin/twin.module.js';
import { CriticalThresholdsController } from './critical-thresholds.controller.js';
import { CriticalThresholdsRepository } from './critical-thresholds.repository.js';

@Module({
  imports: [TwinModule],
  controllers: [CriticalThresholdsController],
  providers: [CriticalThresholdsRepository],
  exports: [CriticalThresholdsRepository],
})
export class CriticalThresholdsModule {}
