export interface RateLimits {
  /** 同一邮箱在时间窗口内允许的失败次数。 */
  perEmail: number;
  /** 同一 IP 在时间窗口内允许的失败次数。 */
  perIp: number;
  windowMs: number;
  /** 最多跟踪多少个键，超出时淘汰最早的，防止内存被撑爆。 */
  maxKeys: number;
}

export const DEFAULT_LIMITS: RateLimits = {
  perEmail: 5,
  perIp: 30,
  windowMs: 15 * 60 * 1000,
  maxKeys: 10_000,
};

/**
 * 登录失败频率限制，单实例内存版。预览环境只有一个实例，够用；
 * 以后多实例部署时换成 Redis 实现，接口不变。
 */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limits: RateLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(ip: string, email: string): boolean {
    return (
      this.count(ipKey(ip)) >= this.limits.perIp ||
      this.count(emailKey(email)) >= this.limits.perEmail
    );
  }

  recordFailure(ip: string, email: string): void {
    this.push(ipKey(ip));
    this.push(emailKey(email));
  }

  /** 登录成功后清掉该邮箱的失败记录；IP 的记录保留。 */
  reset(email: string): void {
    this.failures.delete(emailKey(email));
  }

  private count(key: string): number {
    const cutoff = this.now() - this.limits.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length) this.failures.set(key, recent);
    else this.failures.delete(key);
    return recent.length;
  }

  private push(key: string): void {
    const list = this.failures.get(key) ?? [];
    list.push(this.now());
    // 删除再插入，让 Map 的插入顺序代表最近活跃顺序。
    this.failures.delete(key);
    this.failures.set(key, list);
    while (this.failures.size > this.limits.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }
}

const ipKey = (ip: string) => `ip:${ip}`;
const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
