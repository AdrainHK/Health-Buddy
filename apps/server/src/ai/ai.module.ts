import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config.js';
import { AiController } from './ai.controller.js';
import { buildGateway, LLM_GATEWAY, LLM_PROVIDERS } from './gateway.provider.js';
import { UsageRepository } from './usage.repository.js';

@Module({
  controllers: [AiController],
  providers: [
    UsageRepository,
    {
      provide: LLM_GATEWAY,
      inject: [APP_CONFIG, UsageRepository, { token: LLM_PROVIDERS, optional: true }],
      useFactory: buildGateway,
    },
  ],
  exports: [LLM_GATEWAY],
})
export class AiModule {}
