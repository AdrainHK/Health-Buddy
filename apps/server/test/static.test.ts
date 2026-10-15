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

describe('后台静态页面（/admin/）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const workbench = mkdtempSync(join(tmpdir(), 'hb-workbench-'));
    writeFileSync(join(workbench, 'index.html'), '<!doctype html><title>workbench page</title>');
    const admin = mkdtempSync(join(tmpdir(), 'hb-admin-'));
    writeFileSync(join(admin, 'index.html'), '<!doctype html><title>admin page</title>');
    writeFileSync(join(admin, 'admin.js'), 'console.log(2)');
    app = await createTestApp({ workbenchDist: workbench, adminDist: admin });
  });

  afterAll(() => app.close());

  it('/admin/ 返回后台首页，静态资源从后台目录取', async () => {
    const res = await request(app.getHttpServer()).get('/admin/').expect(200);
    expect(res.text).toContain('admin page');
    const js = await request(app.getHttpServer()).get('/admin/admin.js').expect(200);
    expect(js.text).toContain('console.log(2)');
  });

  it('/admin 跳转到 /admin/', async () => {
    const res = await request(app.getHttpServer()).get('/admin').expect(301);
    expect(res.headers.location).toBe('/admin/');
  });

  it('/admin 下的前端路由回落到后台首页', async () => {
    const res = await request(app.getHttpServer()).get('/admin/thresholds/123').expect(200);
    expect(res.text).toContain('admin page');
  });

  it('工作台页面不受影响', async () => {
    const home = await request(app.getHttpServer()).get('/').expect(200);
    expect(home.text).toContain('workbench page');
    const route = await request(app.getHttpServer()).get('/tasks/123').expect(200);
    expect(route.text).toContain('workbench page');
    // 只是前缀相同的路径仍归工作台
    const similar = await request(app.getHttpServer()).get('/administrator').expect(200);
    expect(similar.text).toContain('workbench page');
  });

  it('接口路径不受影响', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
    const thresholds = await request(app.getHttpServer())
      .get('/api/critical-thresholds')
      .expect(401);
    expect(thresholds.body).toEqual({ error: 'unauthenticated' });
  });
});
