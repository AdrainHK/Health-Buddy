import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * 伴侣设备的凭据（M6 规格 3.2、N2）。
 * - 设备密钥是厂商烧录在 eFuse 里的 256 位 HMAC 密钥（xiaozhi 激活 v2）。服务器要用它验证设备的
 *   HMAC，所以用 COMPANION_DEVICE_KEY 加密保存（DeviceSecretCipher）；另存 SHA-256 防止重复导入。
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

/**
 * 设备密钥的加密：AES-256-GCM，格式为 版本(1 字节) + IV(12) + 认证标签(16) + 密文(32)。
 * 序列号作为附加认证数据：密文挪到别的设备行就解不开。错误信息里不带密钥。
 */
const CIPHER_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DeviceSecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('companion device key must be 32 bytes');
  }

  /** secretHex：64 位十六进制 */
  encrypt(secretHex: string, serialNo: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(serialNo, 'utf8'));
    const body = Buffer.concat([cipher.update(Buffer.from(secretHex, 'hex')), cipher.final()]);
    return Buffer.concat([Buffer.from([CIPHER_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  /** 解不开（密钥换了、密文被挪动）时 undefined */
  decrypt(data: Buffer, serialNo: string): Buffer | undefined {
    if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== CIPHER_VERSION) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(1, 1 + IV_BYTES));
      decipher.setAAD(Buffer.from(serialNo, 'utf8'));
      decipher.setAuthTag(data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      return undefined;
    }
  }
}

/** 激活挑战：32 字节随机数的十六进制（设备按字符串原样参与 HMAC） */
export function newChallenge(): string {
  return randomBytes(32).toString('hex');
}

/** 设备令牌：32 字节随机数，base64url；库里只存 SHA-256 */
export function newDeviceToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** xiaozhi 激活 v2：hmac = hex(HMAC-SHA256(key0, challenge)) */
export function deviceHmac(secret: Buffer, challenge: string): string {
  return createHmac('sha256', secret).update(challenge, 'utf8').digest('hex');
}

export function verifyDeviceHmac(secret: Buffer, challenge: string, hmacHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(hmacHex)) return false;
  return timingSafeEqual(
    Buffer.from(deviceHmac(secret, challenge), 'hex'),
    Buffer.from(hmacHex, 'hex'),
  );
}
