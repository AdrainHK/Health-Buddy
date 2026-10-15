import { Logger } from '@nestjs/common';
import {
  createGateway,
  LlmGateway,
  type GatewayLogger,
  type Provider,
  type ProviderName,
} from '@health-buddy/ai-engine';
import type { AppConfig } from '../config.js';
import type { TenantContext } from '../db/database.js';
import type { UsageRepository } from './usage.repository.js';

export const LLM_GATEWAY = Symbol('LLM_GATEWAY');
/** 测试时注入模拟厂商；生产环境不设置，按密钥创建真实适配器。 */
export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

export type AppGateway = LlmGateway<TenantContext>;

export function buildGateway(
  config: AppConfig,
  usage: UsageRepository,
  providers: Partial<Record<ProviderName, Provider>> | undefined,
): AppGateway {
  const nest = new Logger('LlmGateway');
  // 只输出结构化字段（用途、型号、耗时、token 数），网关本身保证不含原文
  const logger: GatewayLogger = {
    info: (message, fields) => nest.log(`${message} ${JSON.stringify(fields)}`),
    error: (message, fields) => nest.error(`${message} ${JSON.stringify(fields)}`),
  };
  const options = {
    logger,
    recordUsage: (record: Parameters<UsageRepository['record']>[1], ctx: TenantContext) =>
      usage.record(ctx, record),
  };
  return providers
    ? new LlmGateway<TenantContext>({ ...options, config: config.llm, providers })
    : createGateway<TenantContext>(config.llm, options);
}
