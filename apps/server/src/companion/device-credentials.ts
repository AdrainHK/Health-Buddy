import { createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * 伴侣设备的凭据（M6 规格 3.2、N2）。
 * - 设备密钥是厂商烧录的高熵随机串：存 SHA-256，设备每次连接按哈希查找。
 * - 激活码印在设备背面、位数少：存 argon2id（含盐）。参数比登录密码轻，平台一次导入上千台时不至于太慢；
 *   绑定接口另有失败次数限制（BindAttemptLimiter）。
 * 密钥和激活码的原文都不进日志、不进数据库。
 */

const ACTIVATION_OPTIONS = { memoryCost: 4096, timeCost: 2, parallelism: 1 };

export function hashDeviceSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function hashActivationCode(code: string): Promise<string> {
  return hash(code, ACTIVATION_OPTIONS);
}

export async function verifyActivationCode(codeHash: string, code: string): Promise<boolean> {
  try {
    return await verify(codeHash, code);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** 序列号不存在时也做一次同样耗时的验证，避免从响应时间探测哪些序列号存在 */
export async function verifyAgainstDummyCode(code: string): Promise<false> {
  dummyHash ??= hashActivationCode('HBDUMMYCODE0');
  await verifyActivationCode(await dummyHash, code);
  return false;
}

/** 并发数受限地依次算哈希（libuv 线程池默认 4 个线程） */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface BindAttemptLimits {
  /** 同一健管师在时间窗口内允许的失败次数（序列号或激活码不对、设备不可用） */
  perUser: number;
  windowMs: number;
  maxKeys: number;
}

export const DEFAULT_BIND_LIMITS: BindAttemptLimits = {
  perUser: 10,
  windowMs: 15 * 60 * 1000,
  maxKeys: 10_000,
};

/** 绑定失败次数限制，单实例内存版（同 LoginRateLimiter），防止猜激活码 */
export class BindAttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limits: BindAttemptLimits = DEFAULT_BIND_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(userId: string): boolean {
    const cutoff = this.now() - this.limits.windowMs;
    const recent = (this.failures.get(userId) ?? []).filter((t) => t > cutoff);
    if (recent.length) this.failures.set(userId, recent);
    else this.failures.delete(userId);
    return recent.length >= this.limits.perUser;
  }

  recordFailure(userId: string): void {
    const list = this.failures.get(userId) ?? [];
    list.push(this.now());
    this.failures.delete(userId);
    this.failures.set(userId, list);
    while (this.failures.size > this.limits.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }
}
