import { describe, expect, it } from 'vitest';
import { deriveAppDatabaseUrl, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://owner:owner-secret@db.internal:5432/app',
  APP_DATABASE_PASSWORD: 'app-password-1234567',
};

describe('config', () => {
  it('derives the app role URL from the owner URL', () => {
    const url = new URL(deriveAppDatabaseUrl(base.DATABASE_URL, 'p@ss/word'));
    expect(url.username).toBe('hb_app');
    expect(decodeURIComponent(url.password)).toBe('p@ss/word');
    expect(url.host).toBe('db.internal:5432');
    expect(url.pathname).toBe('/app');
  });

  it('only enables secure cookies in production', () => {
    expect(loadConfig({ ...base }).secureCookies).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).secureCookies).toBe(true);
  });

  it('reads the workbench and admin dist directories', () => {
    const config = loadConfig({ ...base, WORKBENCH_DIST: '/w', ADMIN_DIST: '/a' });
    expect(config.workbenchDist).toBe('/w');
    expect(config.adminDist).toBe('/a');
    expect(loadConfig({ ...base }).adminDist).toBeUndefined();
  });

  it('requires both platform admin variables', () => {
    expect(loadConfig({ ...base, PLATFORM_ADMIN_EMAIL: 'a@x.com' }).platformAdmin).toBeUndefined();
  });

  it('names bad variables without printing their values', () => {
    const secret = 'short-secret';
    expect(() => loadConfig({ ...base, APP_DATABASE_PASSWORD: secret })).toThrow(
      /APP_DATABASE_PASSWORD/,
    );
    try {
      loadConfig({ ...base, APP_DATABASE_PASSWORD: secret });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});
