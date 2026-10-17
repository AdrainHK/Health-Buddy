import { describe, expect, it } from 'vitest';
import {
  verifyRejectionSchema,
  verifyUploadRequestSchema,
  verifyUploadResponseSchema,
} from './index.js';

describe('verifyUploadRequestSchema', () => {
  const base = { version: 1, checkedValueIds: [], reportDate: '2026-05-01' };

  it('defaults identityConfirmed and confirmAll to false', () => {
    const r = verifyUploadRequestSchema.parse(base);
    expect(r).toMatchObject({
      identityConfirmed: false,
      confirmAll: false,
      acknowledgedCritical: false,
      saveAsNew: false,
    });
  });

  it('accepts confirm-all with the identity confirmation and no per-row ticks', () => {
    const r = verifyUploadRequestSchema.parse({
      ...base,
      identityConfirmed: true,
      confirmAll: true,
    });
    expect(r.confirmAll).toBe(true);
    expect(r.identityConfirmed).toBe(true);
  });

  it('rejects non-boolean flags', () => {
    expect(verifyUploadRequestSchema.safeParse({ ...base, confirmAll: 'yes' }).success).toBe(false);
    expect(verifyUploadRequestSchema.safeParse({ ...base, identityConfirmed: 1 }).success).toBe(
      false,
    );
  });
});

describe('verifyRejectionSchema', () => {
  it('knows the identity_unconfirmed reason', () => {
    expect(
      verifyRejectionSchema.parse({ error: 'conflict', reasons: ['identity_unconfirmed'] }).reasons,
    ).toEqual(['identity_unconfirmed']);
  });
});

describe('verifyUploadResponseSchema', () => {
  it('critical is optional and validated', () => {
    const shape = verifyUploadResponseSchema.shape.critical;
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse([{ metric: 'fpg' }]).success).toBe(false);
  });
});
