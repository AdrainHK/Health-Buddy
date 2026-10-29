import { Inject, Injectable } from '@nestjs/common';
import {
  CHECKIN_HISTORY_DAYS,
  CHECKIN_PLANS_MAX,
  type Checkin,
  type CheckinPlan,
  type CreateCheckinPlanRequest,
  type UpdateCheckinPlanRequest,
} from '@health-buddy/shared';
import type { Selectable } from 'kysely';
import { dateText, iso } from '../care/common.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type { CheckinPlansTable } from '../db/types.js';
import { localDate } from '../twin/time-zone.js';
import { ownClient } from '../twin/twin.repository.js';

/** 同一位客户的计划串行修改，避免并发时超过启用上限 */
async function lockClient(trx: TenantTransaction, clientId: string): Promise<void> {
  await trx.selectFrom('clients').select('id').where('id', '=', clientId).forUpdate().execute();
}

/**
 * 健管师端的打卡计划和打卡记录（M6 规格 2.3、2.8、6.4）。只有服务这位客户的健管师：
 * 行级安全 + 显式限定本人。打卡记录只读（由福宝的对话和定时任务经数据库函数写）。
 */

export type CheckinPlanResult = CheckinPlan | 'not_found' | 'too_many' | 'unknown_goal';

@Injectable()
export class CheckinsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 计划列表（启用的在前）；不是自己的客户时 undefined（404） */
  plans(ctx: TenantContext, clientId: string): Promise<CheckinPlan[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('checkin_plans')
        .selectAll()
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .orderBy('active', 'desc')
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      return rows.map(toPlan);
    });
  }

  createPlan(
    ctx: TenantContext,
    clientId: string,
    body: CreateCheckinPlanRequest,
  ): Promise<CheckinPlanResult> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      await lockClient(trx, clientId);
      const { count } = await trx
        .selectFrom('checkin_plans')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .where('active', '=', true)
        .executeTakeFirstOrThrow();
      if (Number(count) >= CHECKIN_PLANS_MAX) return 'too_many';
      if (body.goalTemplateId && !(await publishedGoal(trx, body.goalTemplateId))) {
        return 'unknown_goal';
      }
      const row = await trx
        .insertInto('checkin_plans')
        .values({
          client_id: clientId,
          kind: body.kind,
          metric: body.metric,
          slots: JSON.stringify(body.slots),
          goal_template_id: body.goalTemplateId,
          note: body.note,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toPlan(row);
    });
  }

  updatePlan(
    ctx: TenantContext,
    clientId: string,
    planId: string,
    body: UpdateCheckinPlanRequest,
  ): Promise<CheckinPlanResult> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      await lockClient(trx, clientId);
      const current = await trx
        .selectFrom('checkin_plans')
        .select(['id', 'kind', 'active'])
        .where('id', '=', planId)
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .executeTakeFirst();
      if (!current) return 'not_found';
      if (body.goalTemplateId !== undefined && body.goalTemplateId !== null) {
        if (current.kind !== 'exercise') return 'unknown_goal';
        if (!(await publishedGoal(trx, body.goalTemplateId))) return 'unknown_goal';
      }
      if (body.active === true && !current.active) {
        const { count } = await trx
          .selectFrom('checkin_plans')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('client_id', '=', clientId)
          .where('manager_id', '=', ctx.userId)
          .where('active', '=', true)
          .executeTakeFirstOrThrow();
        if (Number(count) >= CHECKIN_PLANS_MAX) return 'too_many';
      }
      const row = await trx
        .updateTable('checkin_plans')
        .set({
          ...(body.slots !== undefined && { slots: JSON.stringify(body.slots) }),
          ...(body.goalTemplateId !== undefined && { goal_template_id: body.goalTemplateId }),
          ...(body.note !== undefined && { note: body.note }),
          ...(body.active !== undefined && { active: body.active }),
        })
        .where('id', '=', planId)
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toPlan(row);
    });
  }

  /** 近 30 天的打卡记录（新的在前）；不是自己的客户时 undefined（404） */
  checkins(ctx: TenantContext, clientId: string): Promise<Checkin[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('checkins as c')
        .innerJoin('checkin_plans as p', (j) =>
          j.onRef('p.id', '=', 'c.plan_id').onRef('p.client_id', '=', 'c.client_id'),
        )
        .select((eb) => [
          'c.id',
          'c.plan_id',
          'p.kind',
          'p.metric',
          dateText(eb, 'c.due_on').as('due_on'),
          'c.slot',
          'c.status',
          'c.reading_values',
          'c.answered_at',
        ])
        .where('c.client_id', '=', clientId)
        .where('c.manager_id', '=', ctx.userId)
        .where((eb) => eb('c.due_on', '>', eb.cast<Date>(eb.val(historyStart()), 'date')))
        .orderBy('c.due_on', 'desc')
        .orderBy('c.created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        planId: r.plan_id,
        kind: r.kind,
        metric: r.metric,
        dueOn: r.due_on,
        slot: r.slot,
        status: r.status,
        values: r.reading_values.map(Number),
        answeredAt: iso(r.answered_at),
      }));
    });
  }
}

/** 近 30 天的起点（北京时间，不含这一天） */
function historyStart(): string {
  const today = localDate(new Date(), 'Asia/Shanghai');
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - CHECKIN_HISTORY_DAYS);
  return d.toISOString().slice(0, 10);
}

async function publishedGoal(trx: TenantTransaction, id: string): Promise<boolean> {
  const row = await trx
    .selectFrom('plan_goal_templates')
    .select('id')
    .where('id', '=', id)
    .where('section', '=', 'exercise')
    .where('status', '=', 'published')
    .executeTakeFirst();
  return !!row;
}

function toPlan(row: Selectable<CheckinPlansTable>): CheckinPlan {
  return {
    id: row.id,
    kind: row.kind,
    metric: row.metric,
    slots: row.slots,
    goalTemplateId: row.goal_template_id,
    note: row.note,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}
