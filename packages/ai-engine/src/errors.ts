export type GatewayErrorKind =
  | 'not_configured'
  | 'provider_error'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  /** 结构化输出重试后仍不符合约定的结构 */
  | 'invalid_output';

/**
 * 网关错误。只带类别、厂商返回的 HTTP 状态码和厂商错误码（如 invalid_api_key），不保留原始异常：
 * 厂商 SDK 的异常消息可能夹带请求内容，留着迟早会被人整个打进日志。
 */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`LLM gateway error: ${kind}${status ? ` (${status})` : ''}${code ? ` [${code}]` : ''}`);
    this.name = 'GatewayError';
  }
}

/** 厂商错误码是固定的英文标识符；不符合这个格式的一律丢弃，避免把任意文本带进日志。 */
function providerErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  // OpenAI 放在 code 上；Anthropic 放在响应体 error.error.type 上（如 not_found_error）
  const body =
    'error' in err ? (err.error as { error?: { type?: unknown } } | undefined) : undefined;
  const code = 'code' in err && err.code ? err.code : body?.error?.type;
  return typeof code === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(code) ? code : undefined;
}

/** 把厂商 SDK 抛出的异常归类，丢掉可能含有请求内容的消息和原始异常。 */
export function classifyError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const status =
    err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
      ? err.status
      : undefined;
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'APIUserAbortError') return new GatewayError('aborted');
  const code = providerErrorCode(err);
  if (status === 429) return new GatewayError('rate_limited', status, code);
  if (name.includes('Timeout')) return new GatewayError('timeout');
  return new GatewayError('provider_error', status, code);
}
