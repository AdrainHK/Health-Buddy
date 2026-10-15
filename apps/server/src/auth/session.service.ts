import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuthRepository, type ResolvedSession } from './auth.repository.js';

export const SESSION_COOKIE = 'hb_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 令牌明文只在 Cookie 里，数据库只存它的 SHA-256。数据库泄露也无法冒用会话。 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

@Injectable()
export class SessionService {
  constructor(private readonly repo: AuthRepository) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.repo.createSession(userId, hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<ResolvedSession | undefined> {
    // 格式明显不对的令牌不查库。
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.repo.resolveSession(hashToken(token));
  }

  async revoke(token: string): Promise<void> {
    await this.repo.revokeSession(hashToken(token));
  }
}
