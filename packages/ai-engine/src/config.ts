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

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** 没有单独配置的用途默认用哪家。Claude API 开通前先用 OpenAI。 */
  LLM_DEFAULT_PROVIDER: providerSchema.default('openai'),
  /** 两家各自的默认型号。 */
  OPENAI_MODEL: z.string().min(1).default('gpt-5'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  LLM_DEFAULT_EFFORT: effortSchema.default('medium'),
  /** 按用途覆盖，JSON 格式，例如 {"expert":{"provider":"anthropic","effort":"high"}} */
  LLM_ROUTES: z.string().optional(),
});

export interface GatewayConfig {
  apiKeys: Partial<Record<ProviderName, string>>;
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
    defaultProvider: env.LLM_DEFAULT_PROVIDER,
    defaultModels: { openai: env.OPENAI_MODEL, anthropic: env.ANTHROPIC_MODEL },
    defaultEffort: env.LLM_DEFAULT_EFFORT,
    routes: parseRoutes(env.LLM_ROUTES),
  };
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

/** 计算某个用途最终使用的厂商、型号和推理强度。 */
export function resolveRoute(config: GatewayConfig, route: Route): ResolvedRoute {
  const override = config.routes[route] ?? {};
  const provider = override.provider ?? config.defaultProvider;
  return {
    provider,
    model: override.model ?? config.defaultModels[provider],
    effort: override.effort ?? config.defaultEffort,
  };
}
