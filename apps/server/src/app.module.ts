import type { Provider as LlmProvider, ProviderName } from '@health-buddy/ai-engine';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AiModule } from './ai/ai.module.js';
import { LLM_PROVIDERS } from './ai/gateway.provider.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DbModule } from './db/db.provider.js';
import { HealthController } from './health/health.controller.js';

export interface AppOptions {
  /** 测试用：替换大模型厂商适配器 */
  llmProviders?: Partial<Record<ProviderName, LlmProvider>>;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule, AuthModule, ClientsModule, AiModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        ...(options.llmProviders
          ? [{ provide: LLM_PROVIDERS, useValue: options.llmProviders }]
          : []),
      ],
      exports: [APP_CONFIG, ...(options.llmProviders ? [LLM_PROVIDERS] : [])],
    };
  }
}
