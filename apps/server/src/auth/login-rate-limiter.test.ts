import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from './login-rate-limiter.js';

const limits = { perEmail: 3, perIp: 5, windowMs: 1000, maxKeys: 4 };

function setup() {
  let now = 0;
  const limiter = new LoginRateLimiter(limits, () => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe('LoginRateLimiter', () => {
  it('blocks an email after the allowed number of failures', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) {
      expect(limiter.isBlocked('1.1.1.1', 'a@x.com')).toBe(false);
      limiter.recordFailure('1.1.1.1', 'a@x.com');
    }
    expect(limiter.isBlocked('2.2.2.2', 'A@X.com ')).toBe(true);
  });

  it('blocks an IP that tries many emails', () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) limiter.recordFailure('1.1.1.1', `u${i}@x.com`);
    expect(limiter.isBlocked('1.1.1.1', 'fresh@x.com')).toBe(true);
    expect(limiter.isBlocked('9.9.9.9', 'fresh@x.com')).toBe(false);
  });

  it('forgets failures after the window', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.1.1.1', 'a@x.com');
    advance(1001);
    expect(limiter.isBlocked('1.1.1.1', 'a@x.com')).toBe(false);
  });

  it('clears the email on reset', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.1.1.1', 'a@x.com');
    limiter.reset('a@x.com');
    expect(limiter.isBlocked('2.2.2.2', 'a@x.com')).toBe(false);
  });

  it('keeps memory bounded', () => {
    const { limiter } = setup();
    for (let i = 0; i < 100; i++) limiter.recordFailure(`10.0.0.${i}`, `u${i}@x.com`);
    // @ts-expect-error 读取私有字段，只为验证上限
    expect(limiter.failures.size).toBeLessThanOrEqual(4);
  });
});
