import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ConsultationService } from './consultation.service.js';
import { ExpertsController } from './experts.controller.js';
import { ExpertsRepository } from './experts.repository.js';

@Module({
  imports: [AiModule],
  controllers: [ExpertsController],
  providers: [ExpertsRepository, ConsultationService],
  exports: [ConsultationService, ExpertsRepository],
})
export class ExpertsModule {}
