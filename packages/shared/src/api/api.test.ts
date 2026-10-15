import { describe, expect, it } from 'vitest';
import { loginRequestSchema } from './auth.js';

describe('loginRequestSchema', () => {
  it('accepts an email and password', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(
      true,
    );
  });

  it('rejects malformed input', () => {
    expect(loginRequestSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(
      false,
    );
    expect(loginRequestSchema.safeParse({ email: 'a@example.com' }).success).toBe(false);
  });
});
