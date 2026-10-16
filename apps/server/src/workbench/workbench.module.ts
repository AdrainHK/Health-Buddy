import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GenerationRegistry } from './generation-registry.js';
import { GenerationService } from './generation.service.js';
import { LLM_RATE_LIMITER, LlmRateLimiter } from './llm-rate-limiter.js';
import { WorkbenchController } from './workbench.controller.js';
import { WorkbenchRepository } from './workbench.repository.js';

@Module({
  imports: [AiModule, AuthModule],
  controllers: [WorkbenchController],
  providers: [
    WorkbenchRepository,
    GenerationService,
    GenerationRegistry,
    { provide: LLM_RATE_LIMITER, useFactory: () => new LlmRateLimiter() },
  ],
  // 上传报告和重新识别也计入同一个每分钟上限（M2 规格 3.4）
  exports: [LLM_RATE_LIMITER],
})
export class WorkbenchModule {}
