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

  it('keeps the expert preview off unless EXPERTS_PREVIEW is exactly true', () => {
    expect(loadConfig({ ...base }).expertsPreview).toBe(false);
    expect(loadConfig({ ...base, EXPERTS_PREVIEW: '' }).expertsPreview).toBe(false);
    expect(loadConfig({ ...base, EXPERTS_PREVIEW: 'false' }).expertsPreview).toBe(false);
    expect(loadConfig({ ...base, EXPERTS_PREVIEW: 'true' }).expertsPreview).toBe(true);
    expect(() => loadConfig({ ...base, EXPERTS_PREVIEW: 'yes' })).toThrow(/EXPERTS_PREVIEW/);
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

  it('enables report storage only when bucket and both keys are set', () => {
    expect(loadConfig({ ...base })).toMatchObject({
      storage: undefined,
      redisUrl: undefined,
      incompleteStorageVars: [],
    });
    const full = loadConfig({
      ...base,
      S3_BUCKET: 'reports',
      S3_ACCESS_KEY_ID: 'key-id',
      S3_SECRET_ACCESS_KEY: 'secret-key',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_FORCE_PATH_STYLE: 'true',
      REDIS_URL: 'redis://default:pw@redis.internal:6379',
    });
    expect(full.storage).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'reports',
      accessKeyId: 'key-id',
      secretAccessKey: 'secret-key',
      forcePathStyle: true,
    });
    expect(full.redisUrl).toBe('redis://default:pw@redis.internal:6379');
    // 只配了一部分：不启用，记下缺的变量名（不含值）
    const partial = loadConfig({ ...base, S3_BUCKET: 'reports', S3_ACCESS_KEY_ID: '' });
    expect(partial.storage).toBeUndefined();
    expect(partial.incompleteStorageVars).toEqual(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
  });

  it('rejects a malformed REDIS_URL without printing it', () => {
    const bad = 'not a url with secret-pw';
    expect(() => loadConfig({ ...base, REDIS_URL: bad })).toThrow(/REDIS_URL/);
    try {
      loadConfig({ ...base, REDIS_URL: bad });
    } catch (err) {
      expect(String(err)).not.toContain('secret-pw');
    }
  });
});
