import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerDb, seedFixtures, type Fixtures } from './fixtures.js';
import { createTestApp, loginAs } from './http.js';
import { insertDraft, insertTask, type Scope } from './work-fixtures.js';

/**
 * M8 第 1 步：工作台首页（规格 2.4，验收 9、13、14）。待审核草稿只列本人的、按生成时间从早到晚；
 * 快捷入口按本人最近 30 天的使用次数排序。合成数据。
 */
describe('工作台首页', () => {
  const owner = ownerDb();
  let app: INestApplication;
  let f: Fixtures;
  let a1: Scope;
  let a2: Scope;
  let b1: Scope;

  const home = async (email: string) =>
    (await (await loginAs(app, email)).get('/api/home').expect(200)).body;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    f = await seedFixtures(owner);
    a1 = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA1.id };
    a2 = { operatorId: f.operatorA, orgId: f.orgA, managerId: f.users.managerA2.id };
    b1 = { operatorId: f.operatorB, orgId: f.orgB, managerId: f.users.managerB1.id };
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
  });

  it('验收 9：待审核草稿按生成时间从早到晚；已确认的不列；只读任务里的不列', async () => {
    const task = await insertTask(owner, a1, f.clients.a1[0]);
    const newer = await insertDraft(owner, a1, task, {
      clientId: f.clients.a1[0],
      createdAt: new Date('2026-10-30T08:00:00Z'),
    });
    const older = await insertDraft(owner, a1, task, {
      clientId: f.clients.a1[0],
      createdAt: new Date('2026-10-20T08:00:00Z'),
    });
    const approved = await insertDraft(owner, a1, task, { clientId: f.clients.a1[0] });
    await owner
      .updateTable('artifacts')
      .set({ status: 'approved' })
      .where('id', '=', approved)
      .execute();
    const detachedTask = await insertTask(owner, a1, f.clients.a1[0]);
    await insertDraft(owner, a1, detachedTask, { clientId: f.clients.a1[0] });
    await owner
      .updateTable('tasks')
      .set({ detached_reason: 'client_transferred', archived_at: new Date() })
      .where('id', '=', detachedTask)
      .execute();

    const body = await home(f.users.managerA1.email);
    expect(body.drafts.total).toBe(2);
    expect(body.drafts.items.map((d: { artifactId: string }) => d.artifactId)).toEqual([
      older,
      newer,
    ]);
    expect(body.drafts.items[0]).toMatchObject({
      taskId: task,
      taskTitle: '测试任务',
      clientId: f.clients.a1[0],
      skillId: 'client-recent-summary',
      status: 'draft',
      hasCriticalFlags: false,
    });
    // 只有 id、标题、时间和数量，不含产物正文
    expect(JSON.stringify(body)).not.toContain('收缩压');
  });

  it('快捷入口：本人最近 30 天用过的技能和专家按次数排；30 天前和别人的不算', async () => {
    const task = await insertTask(owner, a1);
    const message = (scope: Scope, taskId: string, skillId: string, createdAt?: Date) =>
      owner
        .insertInto('task_messages')
        .values({
          operator_id: scope.operatorId,
          org_id: scope.orgId,
          manager_id: scope.managerId,
          task_id: taskId,
          role: 'manager',
          mode: 'craft',
          content: '合成要求',
          skill_id: skillId,
          status: 'complete',
          ...(createdAt ? { created_at: createdAt } : {}),
        } as never)
        .execute();
    await message(a1, task, 'care-plan');
    await message(a1, task, 'visit-script');
    await message(a1, task, 'visit-script');
    await message(a1, task, 'twin-summary', new Date(Date.now() - 40 * 24 * 3600 * 1000));
    const taskA2 = await insertTask(owner, a2);
    for (let i = 0; i < 3; i++) await message(a2, taskA2, 'report-interpretation');

    const body = await home(f.users.managerA1.email);
    expect(body.usage.skills).toEqual(['visit-script', 'care-plan']);
    expect(body.usage.experts).toEqual([]);
  });

  it('验收 13：健管师只看到自己的草稿，同机构和别的协会的都看不到', async () => {
    await insertDraft(owner, a2, await insertTask(owner, a2));
    await insertDraft(owner, b1, await insertTask(owner, b1));
    const mine = await insertDraft(owner, a1, await insertTask(owner, a1));

    const body = await home(f.users.managerA1.email);
    expect(body.drafts.total).toBe(1);
    expect(body.drafts.items.map((d: { artifactId: string }) => d.artifactId)).toEqual([mine]);
    const other = await home(f.users.managerB1.email);
    expect(other.drafts.total).toBe(1);
    expect(JSON.stringify(other)).not.toContain(mine);
  });

  it('验收 14：机构管理员、协会管理员和平台调用首页接口返回 403；未登录 401', async () => {
    for (const email of [
      f.users.orgAdminA.email,
      f.users.operatorAdminA.email,
      f.users.platform.email,
    ]) {
      await (await loginAs(app, email)).get('/api/home').expect(403);
    }
    await request(app.getHttpServer()).get('/api/home').expect(401);
  });
});
