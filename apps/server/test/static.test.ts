import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './http.js';

describe('工作台静态页面', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), 'hb-workbench-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Health Buddy</title>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    app = await createTestApp({ workbenchDist: dist });
  });

  afterAll(() => app.close());

  it('提供首页和静态资源', async () => {
    const home = await request(app.getHttpServer()).get('/').expect(200);
    expect(home.text).toContain('Health Buddy');
    await request(app.getHttpServer()).get('/app.js').expect(200);
  });

  it('前端路由都返回首页', async () => {
    const res = await request(app.getHttpServer()).get('/tasks/123').expect(200);
    expect(res.text).toContain('Health Buddy');
  });

  it('接口路径不会被首页吞掉', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('带安全响应头', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
