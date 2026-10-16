import type { GatewayConfig } from './config.js';
import { LlmGateway, type GatewayOptions } from './gateway.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import type { CallContext, Provider, ProviderName } from './types.js';

/** 按配置里有密钥的厂商创建真实适配器。没有密钥的厂商调用时报 not_configured。 */
export function createGateway<C extends CallContext = CallContext>(
  config: GatewayConfig,
  options: Omit<GatewayOptions<C>, 'config' | 'providers'> = {},
): LlmGateway<C> {
  const providers: Partial<Record<ProviderName, Provider>> = {};
  if (config.apiKeys.openai) providers.openai = new OpenAIProvider(config.apiKeys.openai);
  if (config.apiKeys.anthropic)
    providers.anthropic = new AnthropicProvider(
      config.apiKeys.anthropic,
      undefined,
      config.baseUrls.anthropic,
    );
  return new LlmGateway<C>({ ...options, config, providers });
}
