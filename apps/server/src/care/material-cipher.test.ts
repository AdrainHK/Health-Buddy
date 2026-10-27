import { describe, expect, it } from 'vitest';
import { MaterialCipher } from './material-cipher.js';

describe('MaterialCipher', () => {
  const cipher = new MaterialCipher(Buffer.alloc(32, 3));

  it('round-trips text and never stores it in plain form', () => {
    const text = '合成素材：客户说最近每天走路 20 分钟';
    const data = cipher.encrypt(text);
    expect(data.includes(Buffer.from('走路'))).toBe(false);
    expect(cipher.decrypt(data)).toBe(text);
    // 每次加密的 IV 不同
    expect(cipher.encrypt(text).equals(data)).toBe(false);
  });

  it('rejects tampered data and a wrong key', () => {
    const data = cipher.encrypt('合成');
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => cipher.decrypt(tampered)).toThrow();
    expect(() => new MaterialCipher(Buffer.alloc(32, 4)).decrypt(data)).toThrow();
    expect(() => new MaterialCipher(Buffer.alloc(16))).toThrow();
  });
});
