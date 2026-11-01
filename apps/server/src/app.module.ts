import type { Provider as LlmProvider, ProviderName } from '@health-buddy/ai-engine';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AiModule } from './ai/ai.module.js';
import { ArtifactsModule } from './artifacts/artifacts.module.js';
import { LLM_PROVIDERS } from './ai/gateway.provider.js';
import { AdminAccountsModule } from './admin-accounts/admin-accounts.module.js';
import { BrandModule } from './brand/brand.module.js';
import { PlansModule } from './plans/plans.module.js';
import { OpsDashboardModule } from './ops-dashboard/ops-dashboard.module.js';
import { HomeModule } from './home/home.module.js';
import { ContentModule } from './content/content.module.js';
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
import { ExpertsModule } from './experts/experts.module.js';
import { CareModule } from './care/care.module.js';
import { CompanionModule } from './companion/companion.module.js';
import type { VoiceOptions } from './companion/voice/device-session.js';
import { VOICE_OPTIONS } from './companion/voice/voice-gateway.js';
import { HealthController } from './health/health.controller.js';
import { PlanLibraryModule } from './plan-library/plan-library.module.js';
import { SkillsController } from './skills/skills.controller.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TwinModule } from './twin/twin.module.js';
import { WorkbenchModule } from './workbench/workbench.module.js';
import { RISK_TIER_GUIDE, RISK_TIER_CRITERIA } from './workbench/risk-tier-criteria.js';

export interface AppOptions {
  /** 测试用：替换大模型厂商适配器 */
  llmProviders?: Partial<Record<ProviderName, LlmProvider>>;
  /** 测试用：替换对象存储和报告识别队列 */
  reportInfra?: ReportInfraOverrides;
  /** 测试用：注入合成的风险分层标准（线上还没有确认的标准，见 risk-tier-criteria.ts） */
  riskTierCriteria?: string | null;
  /** 测试用：伴侣语音通道的时间参数（帧间隔、超时、端点检测） */
  voice?: Partial<VoiceOptions>;
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
        ExpertsModule,
        TwinModule,
        PlanLibraryModule,
        CareModule,
        CompanionModule,
        AdminAccountsModule,
        BrandModule,
        PlansModule,
        OpsDashboardModule,
        HomeModule,
        ContentModule,
      ],
      controllers: [HealthController, SkillsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        {
          provide: RISK_TIER_CRITERIA,
          useValue:
            options.riskTierCriteria !== undefined ? options.riskTierCriteria : RISK_TIER_GUIDE,
        },
        ...(options.llmProviders
          ? [{ provide: LLM_PROVIDERS, useValue: options.llmProviders }]
          : []),
        ...(options.reportInfra
          ? [{ provide: REPORT_INFRA_OVERRIDES, useValue: options.reportInfra }]
          : []),
        ...(options.voice ? [{ provide: VOICE_OPTIONS, useValue: options.voice }] : []),
      ],
      exports: [
        APP_CONFIG,
        RISK_TIER_CRITERIA,
        ...(options.llmProviders ? [LLM_PROVIDERS] : []),
        ...(options.reportInfra ? [REPORT_INFRA_OVERRIDES] : []),
        ...(options.voice ? [VOICE_OPTIONS] : []),
      ],
    };
  }
}
