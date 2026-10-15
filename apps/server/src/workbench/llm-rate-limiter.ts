/** 每位健管师每分钟最多 20 次大模型调用（发消息、确认计划、退回重写合计，Q10） */
export const LLM_CALLS_PER_MINUTE = 20;

/**
 * 健管师调用大模型的频率限制，单实例内存版（和登录限流一样，多实例时换 Redis）。
 * 只按用户 id 计数，不记任何内容。
 */
export class LlmRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly limit: number = LLM_CALLS_PER_MINUTE,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** 还有额度就记一次并返回 true；超出返回 false，不记 */
  tryAcquire(userId: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.calls.get(userId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.calls.set(userId, recent);
      return false;
    }
    recent.push(this.now());
    this.calls.set(userId, recent);
    // 顺手清掉长时间没有调用的用户，防止内存只增不减
    if (this.calls.size > 10_000) {
      for (const [key, list] of this.calls) {
        if (!list.some((t) => t > cutoff)) this.calls.delete(key);
      }
    }
    return true;
  }
}

export const LLM_RATE_LIMITER = Symbol('LLM_RATE_LIMITER');
