import { describe, expect, it } from 'vitest';
import { dbErrorCode } from '../src/common/db-error.js';

describe('dbErrorCode', () => {
  it('returns the PostgreSQL or network error code', () => {
    expect(
      dbErrorCode(
        Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' }),
      ),
    ).toBe('28P01');
    expect(dbErrorCode(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(
      'ECONNREFUSED',
    );
  });

  it('looks through the error cause', () => {
    const inner = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect(dbErrorCode(new Error('wrapped', { cause: inner }))).toBe('42P01');
  });

  it('never returns message text', () => {
    expect(dbErrorCode(new Error('secret value in message'))).toBe('unknown');
    expect(dbErrorCode({ code: 'not a code; with text' })).toBe('unknown');
    expect(dbErrorCode(undefined)).toBe('unknown');
  });
});
