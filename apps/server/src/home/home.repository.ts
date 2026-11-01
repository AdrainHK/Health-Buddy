import { Inject, Injectable } from '@nestjs/common';
import {
  HOME_DRAFTS_MAX,
  HOME_SHORTCUT_EXPERTS,
  HOME_SHORTCUT_SKILLS,
  HOME_USAGE_DAYS,
  type HomeResponse,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';

/**
 * 首页数据（M8 规格 2.4）。全部经行级安全按会话读，并且显式限定为本人（manager_id = 当前用户），
 * 不新建表、不读产物正文。
 */
@Injectable()
export class HomeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  home(ctx: TenantContext): Promise<HomeResponse> {
    return withTenant(this.db, ctx, async (trx) => {
      const since = new Date(Date.now() - HOME_USAGE_DAYS * 24 * 60 * 60 * 1000);
      const drafts = trx
        .selectFrom('artifacts')
        .innerJoin('tasks', 'tasks.id', 'artifacts.task_id')
        .where('artifacts.manager_id', '=', ctx.userId)
        .where('artifacts.status', '=', 'draft')
        // 客户转出、删除后的任务只读，里面的草稿已作废；这里再排除一次
        .where('tasks.detached_reason', 'is', null);
      const [rows, count, skills, experts] = await Promise.all([
        drafts
          .select([
            'artifacts.id',
            'artifacts.task_id',
            'tasks.title',
            'artifacts.client_id',
            'artifacts.skill_id',
            'artifacts.version',
            'artifacts.status',
            'artifacts.critical_flags',
            'artifacts.created_at',
          ])
          .orderBy('artifacts.created_at')
          .orderBy('artifacts.id')
          .limit(HOME_DRAFTS_MAX)
          .execute(),
        drafts.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
        trx
          .selectFrom('task_messages')
          .select('skill_id')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('manager_id', '=', ctx.userId)
          .where('role', '=', 'manager')
          .where('skill_id', 'is not', null)
          .where('created_at', '>=', since)
          .groupBy('skill_id')
          .orderBy('n', 'desc')
          .orderBy('skill_id')
          .limit(HOME_SHORTCUT_SKILLS * 3)
          .execute(),
        trx
          .selectFrom('expert_calls')
          .select('expert_id')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('manager_id', '=', ctx.userId)
          .where('started_at', '>=', since)
          .groupBy('expert_id')
          .orderBy('n', 'desc')
          .orderBy('expert_id')
          .limit(HOME_SHORTCUT_EXPERTS * 3)
          .execute(),
      ]);
      return {
        drafts: {
          total: Number(count.n),
          items: rows.map((r) => ({
            artifactId: r.id,
            taskId: r.task_id,
            taskTitle: r.title,
            clientId: r.client_id,
            skillId: r.skill_id,
            version: r.version,
            status: r.status,
            hasCriticalFlags: Array.isArray(r.critical_flags) && r.critical_flags.length > 0,
            createdAt: r.created_at.toISOString(),
          })),
        },
        usage: {
          skills: skills.map((s) => s.skill_id).filter((id): id is string => id !== null),
          experts: experts.map((e) => e.expert_id),
        },
      };
    });
  }
}
