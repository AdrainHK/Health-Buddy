/** 大模型网关的统一接口。业务代码只依赖这里的类型，不直接接触任何厂商 SDK。 */

export type ProviderName = 'openai' | 'anthropic';
export type Effort = 'low' | 'medium' | 'high';

/**
 * 调用用途。每个用途可以单独配置厂商、型号和推理强度，计量时也按用途统计。
 * 新功能新增用途时在这里登记。
 */
export const ROUTES = [
  'smoke', // 部署后的连通性检查
  'chat', // 工作台对话（M1）
  'report_interpretation', // 体检报告解读（M2）
  'expert', // 专家智能体（M3）
  'companion', // AI 健康伴侣（M6）
] as const;
export type Route = (typeof ROUTES)[number];

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GatewayRequest {
  route: Route;
  system?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
}

/** 谁发起的调用，用于计量和成本归属。只放 id，不放任何个人信息。 */
export interface CallContext {
  operatorId: string | null;
  userId: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * 统一的结束原因：
 * - complete：正常结束
 * - truncated：达到输出上限被截断
 * - refused：厂商的安全策略拒答（两家统一成这一种）
 */
export type FinishReason = 'complete' | 'truncated' | 'refused';

export type GatewayEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; finishReason: FinishReason; usage: Usage; model: string };

export interface ResolvedRoute {
  provider: ProviderName;
  model: string;
  effort: Effort;
}

/** 厂商适配器。每家实现一个，网关负责其余的一切（配置、计量、日志）。 */
export interface Provider {
  readonly name: ProviderName;
  stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent>;
}

/** 一次调用的计量记录。不含提示词和回答原文。 */
export interface UsageRecord {
  route: Route;
  provider: ProviderName;
  model: string;
  operatorId: string | null;
  userId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  outcome: FinishReason | 'error';
  errorType?: string;
}

export interface GatewayLogger {
  info(message: string, fields: Record<string, string | number | null>): void;
  error(message: string, fields: Record<string, string | number | null>): void;
}
