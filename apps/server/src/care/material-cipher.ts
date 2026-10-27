import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 随访素材原文的加密（M5 规格 2.9：“加密存储同报告原件”）。素材原文存在数据库 bytea 列里，
 * 用 AES-256-GCM 加密：格式为 版本(1 字节) + IV(12) + 认证标签(16) + 密文。
 * 密钥来自 VISIT_MATERIAL_KEY，不进数据库；错误信息里不带原文。
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MaterialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('visit material key must be 32 bytes');
  }

  encrypt(text: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(data: Buffer): string {
    if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== VERSION) {
      throw new Error('unsupported material ciphertext');
    }
    const iv = data.subarray(1, 1 + IV_BYTES);
    const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}
