export type GatewayErrorKind =
  'not_configured' | 'provider_error' | 'rate_limited' | 'timeout' | 'aborted';

/**
 * 网关错误。只带类别和厂商返回的 HTTP 状态码，不保留原始异常：
 * 厂商 SDK 的异常消息可能夹带请求内容，留着迟早会被人整个打进日志。
 */
export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    readonly status?: number,
  ) {
    super(`LLM gateway error: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'GatewayError';
  }
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
  if (status === 429) return new GatewayError('rate_limited', status);
  if (name.includes('Timeout')) return new GatewayError('timeout');
  return new GatewayError('provider_error', status);
}
