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
  'skill', // 工作台技能执行（M1）
  'report_interpretation', // 体检报告解读（M2）
  'report_extraction', // 体检报告识别：从报告图片或 PDF 转录指标（M2）
  'expert', // 专家智能体：每位专家的意见（M3）
  'expert_routing', // 专家路由：补充规则没覆盖的专家（M3 规格 3.2）
  'expert_synthesis', // 专家意见汇总和分歧标注（M3 规格 3.5）
  'companion', // AI 健康伴侣（M6）
  'speech_to_text', // 语音识别：伴侣设备的语音转文字（M6 规格 3.1）
  'text_to_speech', // 语音合成：伴侣设备的文字转语音（M6 规格 3.1）
] as const;
export type Route = (typeof ROUTES)[number];

/** 图片输入支持的格式。HEIC 等其他格式由调用方先转换。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * 消息内容的一段：文字、图片或 PDF（M2 报告识别）。
 * 图片和 PDF 用 base64 传入，由各厂商适配器转换成自己的格式。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string }
  | { type: 'pdf'; data: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** 纯文本，或若干段内容（图片和 PDF 只能出现在 user 消息里） */
  content: string | ContentPart[];
}

/** 结构化输出：要求模型按 JSON Schema 输出。两家都用各自的原生能力约束。 */
export interface ResponseFormat {
  /** 只含字母、数字、下划线和短横线，OpenAI 要求 */
  name: string;
  schema: Record<string, unknown>;
}

export interface GatewayRequest {
  route: Route;
  system?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  responseFormat?: ResponseFormat;
  /** 专家调用时的专家 id（M3 规格 3.7），只用于计量和日志；平台级的 id，不是个人信息 */
  expertId?: string;
}

/**
 * 谁发起的调用，用于计量和成本归属。只放 id，不放任何个人信息。
 * 伴侣设备发起的调用没有用户（userId 为 null），由调用方按设备计量（M6 规格 3.4）。
 */
export interface CallContext {
  operatorId: string | null;
  userId: string | null;
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

/** 语音识别请求。音频只在内存里转交厂商，不落盘、不进日志。 */
export interface TranscribeRequest {
  route: 'speech_to_text';
  /** Ogg 封装的 Opus 音频 */
  audio: Uint8Array;
  mediaType: 'audio/ogg';
  /** ISO-639-1，伴侣固定为 zh */
  language?: string;
}

export interface TranscribeResult {
  text: string;
  usage: Usage;
  model: string;
}

/** 语音合成请求。输出固定为 Ogg 封装的 Opus（设备端直接按帧播放）。 */
export interface SynthesizeRequest {
  route: 'text_to_speech';
  text: string;
  /** 厂商的音色名，不填用适配器默认 */
  voice?: string;
  /** 语速倍数，1 为正常 */
  speed?: number;
  /** 语气说明（支持时生效），例如“语速平缓、亲切” */
  instructions?: string;
}

export interface SynthesizeResult {
  /** Ogg Opus 字节 */
  audio: Uint8Array;
  usage: Usage;
  model: string;
}

/** 厂商适配器。每家实现一个，网关负责其余的一切（配置、计量、日志）。 */
export interface Provider {
  readonly name: ProviderName;
  stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent>;
  /** 不支持语音的厂商不实现，网关报 not_configured */
  transcribe?(
    request: TranscribeRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): Promise<TranscribeResult>;
  synthesize?(
    request: SynthesizeRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult>;
}

/** 一次调用的计量记录。不含提示词和回答原文。 */
export interface UsageRecord {
  route: Route;
  provider: ProviderName;
  model: string;
  operatorId: string | null;
  userId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  outcome: FinishReason | 'error';
  errorType?: string;
  /** 专家、路由、汇总以外的调用没有 */
  expertId?: string;
}

export interface GatewayLogger {
  info(message: string, fields: Record<string, string | number | null>): void;
  error(message: string, fields: Record<string, string | number | null>): void;
}
