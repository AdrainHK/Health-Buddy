import { z } from 'zod';
import { ROUTES, type Effort, type ProviderName, type ResolvedRoute, type Route } from './types.js';

const providerSchema = z.enum(['openai', 'anthropic']);
const effortSchema = z.enum(['low', 'medium', 'high']);

const routeOverrideSchema = z
  .object({
    provider: providerSchema.optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
  })
  .strict();

/** 空字符串按“没有配置”处理：CI 里没设置的密钥会以空字符串传进来 */
const optionalKey = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

/** 空字符串按默认值处理：CI 里没设置的仓库变量会以空字符串传进来 */
const emptyAsUnset = (v: unknown) => (v === '' ? undefined : v);

const envSchema = z.object({
  OPENAI_API_KEY: optionalKey,
  ANTHROPIC_API_KEY: optionalKey,
  /** Claude 走中转服务时填中转地址；不填用官方地址。 */
  ANTHROPIC_BASE_URL: z.preprocess(emptyAsUnset, z.url().optional()),
  /** 没有单独配置的用途默认用哪家。Claude API 开通前先用 OpenAI。 */
  LLM_DEFAULT_PROVIDER: providerSchema.default('openai'),
  /** 两家各自的默认型号。 */
  OPENAI_MODEL: z.preprocess(emptyAsUnset, z.string().min(1).default('gpt-6.1-sol')),
  ANTHROPIC_MODEL: z.preprocess(emptyAsUnset, z.string().min(1).default('claude-opus-5-5')),
  LLM_DEFAULT_EFFORT: effortSchema.default('medium'),
  /** 按用途覆盖，JSON 格式，例如 {"expert":{"provider":"anthropic","effort":"high"}} */
  LLM_ROUTES: z.string().optional(),
});

export interface GatewayConfig {
  apiKeys: Partial<Record<ProviderName, string>>;
  /** 只在走中转服务时设置 */
  baseUrls: Partial<Record<ProviderName, string>>;
  defaultProvider: ProviderName;
  defaultModels: Record<ProviderName, string>;
  defaultEffort: Effort;
  routes: Partial<Record<Route, z.infer<typeof routeOverrideSchema>>>;
}

export function loadGatewayConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // 只报变量名，不打印值（可能是密钥）
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`大模型网关配置有误：${names.join('、')}`);
  }
  const env = parsed.data;
  return {
    apiKeys: {
      ...(env.OPENAI_API_KEY ? { openai: env.OPENAI_API_KEY } : {}),
      ...(env.ANTHROPIC_API_KEY ? { anthropic: env.ANTHROPIC_API_KEY } : {}),
    },
    baseUrls: env.ANTHROPIC_BASE_URL ? { anthropic: relayRoot(env.ANTHROPIC_BASE_URL) } : {},
    defaultProvider: env.LLM_DEFAULT_PROVIDER,
    defaultModels: { openai: env.OPENAI_MODEL, anthropic: env.ANTHROPIC_MODEL },
    defaultEffort: env.LLM_DEFAULT_EFFORT,
    routes: parseRoutes(env.LLM_ROUTES),
  };
}

/**
 * SDK 会自己拼 /v1/messages。中转给的地址常带 /v1 或 OpenAI 兼容的 /v1/chat/completions，
 * 原样传进去路径会重复成 404，这里只保留根地址。
 */
function relayRoot(url: string): string {
  return url
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
    .replace(/\/v1$/, '');
}

function parseRoutes(raw: string | undefined): GatewayConfig['routes'] {
  if (!raw) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('大模型网关配置有误：LLM_ROUTES 不是合法的 JSON');
  }
  const result = z.record(z.string(), routeOverrideSchema).safeParse(json);
  const known = new Set<string>(ROUTES);
  if (!result.success || Object.keys(result.data).some((k) => !known.has(k))) {
    throw new Error('大模型网关配置有误：LLM_ROUTES 里有未知的用途或字段');
  }
  return result.data as GatewayConfig['routes'];
}

/**
 * 语音用途不跟随默认厂商和型号：Claude 没有语音接口，默认用 OpenAI 的语音型号。
 * 仍可用 LLM_ROUTES 覆盖（例如换型号）。
 */
const SPEECH_DEFAULTS: Partial<Record<Route, { provider: ProviderName; model: string }>> = {
  speech_to_text: { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
  text_to_speech: { provider: 'openai', model: 'gpt-4o-mini-tts' },
};

/** 计算某个用途最终使用的厂商、型号和推理强度。 */
export function resolveRoute(config: GatewayConfig, route: Route): ResolvedRoute {
  const override = config.routes[route] ?? {};
  const speech = SPEECH_DEFAULTS[route];
  const provider = override.provider ?? speech?.provider ?? config.defaultProvider;
  return {
    provider,
    model:
      override.model ??
      (speech && speech.provider === provider ? speech.model : config.defaultModels[provider]),
    effort: override.effort ?? config.defaultEffort,
  };
}
