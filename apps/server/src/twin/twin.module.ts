import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { LlmRateLimiter } from '../workbench/llm-rate-limiter.js';
import { MONITORING_MANUAL_PER_MINUTE } from '@health-buddy/shared';
import { FollowUpsController } from './follow-ups.controller.js';
import { FollowUpsRepository } from './follow-ups.repository.js';
import { TwinComputeService } from './twin-compute.service.js';
import { BullMqTwinQueue, InProcessTwinQueue, TWIN_QUEUE, type TwinQueue } from './twin-queue.js';
import { TwinRulesController } from './twin-rules.controller.js';
import { TwinRulesRepository } from './twin-rules.repository.js';
import { MONITORING_RATE_LIMITER, TwinController } from './twin.controller.js';
import { TwinRepository } from './twin.repository.js';

/** 测试用：替换孪生计算队列 */
export const TWIN_QUEUE_OVERRIDE = Symbol('TWIN_QUEUE_OVERRIDE');

@Module({
  controllers: [TwinController, FollowUpsController, TwinRulesController],
  providers: [
    TwinRepository,
    FollowUpsRepository,
    TwinRulesRepository,
    TwinComputeService,
    {
      provide: MONITORING_RATE_LIMITER,
      useFactory: () => new LlmRateLimiter(MONITORING_MANUAL_PER_MINUTE),
    },
    {
      provide: TWIN_QUEUE,
      inject: [APP_CONFIG, { token: TWIN_QUEUE_OVERRIDE, optional: true }],
      useFactory: (config: AppConfig, override?: TwinQueue): TwinQueue => {
        if (override) return override;
        // 没有 Redis 时在进程内执行：孪生计算不调用大模型，本地和测试照常工作
        return config.redisUrl ? new BullMqTwinQueue(config.redisUrl) : new InProcessTwinQueue();
      },
    },
  ],
  exports: [TwinComputeService, TWIN_QUEUE],
})
export class TwinModule {}
