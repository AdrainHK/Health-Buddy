import { hash, verify } from '@node-rs/argon2';

// argon2id（库的默认算法），参数取 OWASP 推荐的最低配置：19 MiB 内存、2 次迭代、单线程。
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // 哈希格式不对时按验证失败处理，不把异常带到上层。
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * 邮箱不存在时也做一次同样耗时的验证，让“邮箱不存在”和“密码错误”的响应时间一致，
 * 避免通过响应时间探测哪些邮箱注册过。
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('health-buddy-dummy-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
