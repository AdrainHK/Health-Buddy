import type { Provider as LlmProvider, ProviderName } from '@health-buddy/ai-engine';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AiModule } from './ai/ai.module.js';
import { ArtifactsModule } from './artifacts/artifacts.module.js';
import { LLM_PROVIDERS } from './ai/gateway.provider.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import {
  REPORT_INFRA_OVERRIDES,
  ReportsModule,
  type ReportInfraOverrides,
} from './reports/reports.module.js';
import { CriticalThresholdsModule } from './critical-thresholds/critical-thresholds.module.js';
import { ApiExceptionFilter } from './common/exception.filter.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DbModule } from './db/db.provider.js';
import { HealthController } from './health/health.controller.js';
import { SkillsController } from './skills/skills.controller.js';
import { TasksModule } from './tasks/tasks.module.js';
import { WorkbenchModule } from './workbench/workbench.module.js';
import {
  CONFIRMED_RISK_TIER_CRITERIA,
  RISK_TIER_CRITERIA,
} from './workbench/risk-tier-criteria.js';

export interface AppOptions {
  /** 测试用：替换大模型厂商适配器 */
  llmProviders?: Partial<Record<ProviderName, LlmProvider>>;
  /** 测试用：替换对象存储和报告识别队列 */
  reportInfra?: ReportInfraOverrides;
  /** 测试用：注入合成的风险分层标准（线上还没有确认的标准，见 risk-tier-criteria.ts） */
  riskTierCriteria?: string | null;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DbModule,
        AuthModule,
        ClientsModule,
        CriticalThresholdsModule,
        TasksModule,
        ArtifactsModule,
        WorkbenchModule,
        ReportsModule,
        AiModule,
      ],
      controllers: [HealthController, SkillsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        {
          provide: RISK_TIER_CRITERIA,
          useValue:
            options.riskTierCriteria !== undefined
              ? options.riskTierCriteria
              : CONFIRMED_RISK_TIER_CRITERIA,
        },
        ...(options.llmProviders
          ? [{ provide: LLM_PROVIDERS, useValue: options.llmProviders }]
          : []),
        ...(options.reportInfra
          ? [{ provide: REPORT_INFRA_OVERRIDES, useValue: options.reportInfra }]
          : []),
      ],
      exports: [
        APP_CONFIG,
        RISK_TIER_CRITERIA,
        ...(options.llmProviders ? [LLM_PROVIDERS] : []),
        ...(options.reportInfra ? [REPORT_INFRA_OVERRIDES] : []),
      ],
    };
  }
}
