import { Logger, type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_RATE_LIMITER } from '../src/brand/brand.controller.js';
import { checkLogo } from '../src/brand/logo.js';
import type { LoginRateLimiter } from '../src/auth/login-rate-limiter.js';
import { DB } from '../src/db/db.provider.js';
import { withTenant, type Db } from '../src/db/database.js';
import { InMemoryObjectStorage } from '../src/reports/storage.js';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';

/** 合成的 PNG：只需要文件头和 IHDR（宽高），后面的数据不解析 */
function png(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0e7c6b"/></svg>';
const BRAND = {
  displayName: '合成协会品牌',
  primaryColor: '#1D4ED8',
  loginGreeting: '欢迎使用合成协会的健康管理工作台',
};

/**
 * M7 第 3 步：协会品牌（规格 2.2、2.3，验收 2、13、17）。只有运营商管理员改本协会的；
 * 登录页按协会简称读公开字段；Logo 按内容检查，SVG 不能带脚本和外部引用。全部是合成数据。
 */
describe('协会品牌', () => {
  const owner = ownerDb();
  const storage = new InMemoryObjectStorage();
  let app: INestApplication;
  let noStorageApp: INestApplication;
  let f: Fixtures;

  const as = (email: string) => loginAs(app, email);
  const anon = () => request.agent(app.getHttpServer());
  const upload = (agent: Awaited<ReturnType<typeof loginAs>>, body: Buffer, name = 'logo.png') =>
    agent.post('/api/admin/brand/logo').attach('file', body, name);
  const slugOf = async (id: string) =>
    (
      await owner
        .selectFrom('operators')
        .select('slug')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).slug;

  beforeAll(async () => {
    app = await createTestApp({}, { reportInfra: { objectStorage: storage } });
    noStorageApp = await createTestApp({}, { reportInfra: { objectStorage: null } });
  });

  beforeEach(async () => {
    app.get<LoginRateLimiter>(BRAND_RATE_LIMITER).clear();
    storage.objects.clear();
    f = await seedFixtures(owner);
  });

  afterAll(async () => {
    await app.close();
    await noStorageApp.close();
    await owner.destroy();
  });

  it('验收 2：协会管理员改名称、主色、欢迎语，换 Logo；登录页读公开字段，登录后 /me 带品牌', async () => {
    const opA = await as(f.users.operatorAdminA.email);
    const saved = (await opA.put('/api/admin/brand').send(BRAND).expect(200)).body.brand;
    expect(saved).toMatchObject({
      displayName: '合成协会品牌',
      primaryColor: '#1d4ed8',
      loginGreeting: BRAND.loginGreeting,
      logoUrl: null,
    });
    const withLogo = (await upload(opA, png(256, 128)).expect(200)).body.brand;
    const slug = await slugOf(f.operatorA);
    expect(withLogo.logoUrl).toMatch(new RegExp(`^/api/public/brand/logo/${slug}\\?v=\\d+$`));
    expect(storage.objects.size).toBe(1);
    // 换成 SVG：旧文件删除
    const svg = (await upload(opA, Buffer.from(SVG), 'logo.svg').expect(200)).body.brand;
    expect(storage.objects.size).toBe(1);
    expect([...storage.objects.values()][0]!.contentType).toBe('image/svg+xml');

    const pub = await anon().get(`/api/public/brand?slug=${slug}`).expect(200);
    expect(pub.body).toEqual({
      brand: {
        name: '合成协会品牌',
        primaryColor: '#1d4ed8',
        loginGreeting: BRAND.loginGreeting,
        logoUrl: svg.logoUrl,
      },
    });
    expect(JSON.stringify(pub.body)).not.toContain(f.operatorA);
    const logo = await anon().get(svg.logoUrl).expect(200);
    expect(logo.headers['content-type']).toContain('image/svg+xml');
    expect(logo.headers['x-content-type-options']).toBe('nosniff');
    expect(logo.headers['content-security-policy']).toContain('sandbox');

    const manager = await as(f.users.managerA1.email);
    const me = (await manager.get('/api/auth/me').expect(200)).body.user.operator;
    expect(me).toMatchObject({
      brandColor: '#1d4ed8',
      brandName: '合成协会品牌',
      logoUrl: svg.logoUrl,
    });
    // 别的协会的健管师看不到 A 的品牌
    const b = await as(f.users.managerB1.email);
    expect((await b.get('/api/auth/me').expect(200)).body.user.operator).toMatchObject({
      brandName: null,
      logoUrl: null,
    });
    // 清空：名称、欢迎语回到默认
    await opA
      .put('/api/admin/brand')
      .send({ displayName: '', primaryColor: null, loginGreeting: '' })
      .expect(200);
    expect(
      (await anon().get(`/api/public/brand?slug=${slug}`).expect(200)).body.brand,
    ).toMatchObject({
      name: '测试协会A',
      primaryColor: null,
      loginGreeting: null,
    });
  });

  it('验收 17：显示名称或欢迎语含禁用词、主色和白色对比度不够时不能保存，标出字段', async () => {
    const opA = await as(f.users.operatorAdminA.email);
    const res = await opA
      .put('/api/admin/brand')
      .send({
        displayName: '合成治愈协会',
        primaryColor: '#ffcc00',
        loginGreeting: '这里能根治慢病',
      })
      .expect(400);
    expect(res.body).toEqual({
      error: 'invalid_content',
      issues: [
        { field: 'displayName', reason: 'banned_term' },
        { field: 'loginGreeting', reason: 'banned_term' },
        { field: 'primaryColor', reason: 'low_contrast' },
      ],
    });
    await opA
      .put('/api/admin/brand')
      .send({ ...BRAND, displayName: 'x'.repeat(21) })
      .expect(400);
    await opA
      .put('/api/admin/brand')
      .send({ ...BRAND, primaryColor: 'red;x' })
      .expect(400);
    expect(await owner.selectFrom('operator_brands').selectAll().execute()).toEqual([]);
  });

  it('Logo 按内容检查：格式、大小、尺寸；SVG 不能带脚本、事件、外部引用', async () => {
    const opA = await as(f.users.operatorAdminA.email);
    await upload(opA, Buffer.from('GIF89a not a logo'), 'logo.png').expect(415);
    expect((await upload(opA, png(16, 16)).expect(400)).body.reasons).toEqual(['bad_dimensions']);
    await upload(opA, png(2000, 100)).expect(400);
    await upload(opA, Buffer.alloc(501 * 1024, 1), 'big.png').expect(413);
    for (const bad of [
      '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
      '<svg viewBox="0 0 10 10"><a href="https://example.com/x"><rect/></a></svg>',
      '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,AAAA"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 10 10"></svg>',
    ]) {
      expect((await upload(opA, Buffer.from(bad), 'x.svg').expect(400)).body.reasons).toEqual([
        'unsafe_svg',
      ]);
    }
    expect(storage.objects.size).toBe(0);
    // 没配置对象存储：503，不读文件
    const noStorage = await loginAs(noStorageApp, f.users.operatorAdminA.email);
    await noStorage.post('/api/admin/brand/logo').attach('file', png(64, 64), 'a.png').expect(503);
    // 单元：内部引用允许
    expect(checkLogo(Buffer.from('<svg viewBox="0 0 10 10"><use href="#a"/></svg>'))).toEqual({
      ok: true,
      type: 'image/svg+xml',
    });
  });

  it('验收 13、Q16：平台、机构管理员、健管师不能改品牌；协会 A 只改得到自己，B 不变', async () => {
    const opB = await as(f.users.operatorAdminB.email);
    await opB
      .put('/api/admin/brand')
      .send({ ...BRAND, displayName: '合成协会B' })
      .expect(200);
    for (const email of [
      f.users.platform.email,
      f.users.orgAdminA.email,
      f.users.managerA1.email,
    ]) {
      const agent = await as(email);
      await agent.get('/api/admin/brand').expect(403);
      await agent.put('/api/admin/brand').send(BRAND).expect(403);
      await upload(agent, png(64, 64)).expect(403);
    }
    const opA = await as(f.users.operatorAdminA.email);
    await opA.put('/api/admin/brand').send(BRAND).expect(200);
    const rows = await owner
      .selectFrom('operator_brands')
      .select(['operator_id', 'display_name'])
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { operator_id: f.operatorA, display_name: '合成协会品牌' },
        { operator_id: f.operatorB, display_name: '合成协会B' },
      ]),
    );
    expect((await opA.get('/api/admin/brand').expect(200)).body.brand.displayName).toBe(
      '合成协会品牌',
    );
    // 审计：A 的记录只有 A 的品牌字段
    const audit = await owner
      .selectFrom('admin_audit_log')
      .select(['operator_id', 'after'])
      .where('operator_id', '=', f.operatorA)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ brand_name: '合成协会品牌', brand_color: '#1d4ed8' });
  });

  it('数据库层：非运营商管理员、伪造协会的会话调用写函数被拒绝；停用的协会登录页 404', async () => {
    const db = app.get<Db>(DB);
    const ctxA = {
      userId: f.users.operatorAdminA.id,
      role: 'operator_admin' as const,
      operatorId: f.operatorA,
      orgId: null,
    };
    for (const ctx of [
      { ...ctxA, operatorId: f.operatorB },
      {
        userId: f.users.managerA1.id,
        role: 'manager' as const,
        operatorId: f.operatorA,
        orgId: f.orgA,
      },
      {
        userId: f.users.platform.id,
        role: 'platform_admin' as const,
        operatorId: null,
        orgId: null,
      },
    ]) {
      await expect(
        withTenant(db, ctx, (trx) => sql`select admin_update_brand('x', null, null)`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // 应用角色不能直接写品牌表
    await expect(
      withTenant(db, ctxA, (trx) =>
        sql`insert into operator_brands (operator_id, display_name) values (${f.operatorB}, 'x')`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const slugC = (
      await owner
        .selectFrom('operators')
        .select('slug')
        .where('status', '=', 'suspended')
        .executeTakeFirstOrThrow()
    ).slug;
    await anon().get(`/api/public/brand?slug=${slugC}`).expect(404);
    await anon().get('/api/public/brand?slug=no-such-assoc').expect(404);
    await anon().get('/api/public/brand?slug=Bad%20Slug').expect(404);
  });

  it('日志里没有品牌文字以外的个人信息', async () => {
    const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
    const spies = methods.flatMap((m) => [vi.spyOn(Logger.prototype, m), vi.spyOn(Logger, m)]);
    try {
      const opA = await as(f.users.operatorAdminA.email);
      await opA.put('/api/admin/brand').send(BRAND).expect(200);
      await upload(opA, png(64, 64)).expect(200);
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(logged).not.toContain(f.users.operatorAdminA.email);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
