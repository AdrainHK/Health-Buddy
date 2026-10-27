import { describe, expect, it } from 'vitest';
import { MaterialCipher } from './material-cipher.js';

describe('MaterialCipher', () => {
  const cipher = new MaterialCipher(Buffer.alloc(32, 3));

  it('round-trips text and never stores it in plain form', () => {
    const text = '合成素材：客户说最近每天走路 20 分钟';
    const data = cipher.encrypt(text, 'client-a');
    expect(data.includes(Buffer.from('走路'))).toBe(false);
    expect(cipher.decrypt(data, 'client-a')).toBe(text);
    // 每次加密的 IV 不同
    expect(cipher.encrypt(text, 'client-a').equals(data)).toBe(false);
  });

  it('rejects tampered data and a wrong key', () => {
    const data = cipher.encrypt('合成', 'client-a');
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => cipher.decrypt(tampered, 'client-a')).toThrow();
    expect(() => new MaterialCipher(Buffer.alloc(32, 4)).decrypt(data, 'client-a')).toThrow();
    // 挪到别的客户名下解不开
    expect(() => cipher.decrypt(data, 'client-b')).toThrow();
    expect(() => new MaterialCipher(Buffer.alloc(16))).toThrow();
  });
});
