import { Inject, Injectable } from '@nestjs/common';
import {
  VISIT_MAX_AHEAD_MONTHS,
  VISIT_MISSED_POSTPONE_DAYS,
  type CreateVisitRequest,
  type TodayVisitsResponse,
  type UpdateVisitRequest,
  type Visit,
  type VisitListQuery,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { addDays, daysBetween, localDate } from '../twin/time-zone.js';
import { clientVisible, ownClient } from '../twin/twin.repository.js';
import { dateText, iso, managerTimeZone } from './common.js';

/**
 * 随访日程和今日随访（M5 规格 2.7、6.4、Q19）。只有服务这位客户的健管师能看和处理（行级安全，Q28）。
 * 随访计划和方案复评只经确认函数写入（3b）；这里只有手动“加一次随访”和处理。
 * 重点和备注只存数据库，不进日志和处理记录（visit_events 由触发器写，只记动作）。
 */

const LIST_LIMIT = 500;

export type VisitWriteResult = Visit | 'not_found' | 'closed' | 'invalid_date' | 'linked_not_found';

/** 今日随访的排序：方案复评和跟进项回访在前（规格 2.7） */
const PURPOSE_ORDER: Record<Visit['purpose'], number> = {
  plan_review: 0,
  follow_up: 0,
  routine: 1,
  adhoc: 1,
};

@Injectable()
export class VisitsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 随访日程；clientId 不是自己的客户时返回 undefined（404） */
  list(ctx: TenantContext, query: VisitListQuery): Promise<Visit[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (query.clientId && !(await clientVisible(trx, query.clientId))) return undefined;
      // 行级安全之外再显式限定本人（纵深防御）
      let q = selectVisits(trx).where('visits.manager_id', '=', ctx.userId);
      if (query.clientId) q = q.where('client_id', '=', query.clientId);
      if (query.status) q = q.where('status', '=', query.status);
      // date 列按 YYYY-MM-DD 文本比较（不转 JS Date，避免时区挪一天）
      if (query.from) q = q.where('due_date', '>=', query.from as never);
      if (query.to) q = q.where('due_date', '<=', query.to as never);
      const rows = await q.orderBy('due_date').orderBy('created_at').limit(LIST_LIMIT).execute();
      return rows.map(toVisit);
    });
  }

  /** 今日随访：今天到期和逾期未处理的（待随访、未联系上），当前健管师的全部客户 */
  today(ctx: TenantContext, tzFallback?: string): Promise<TodayVisitsResponse> {
    return withTenant(this.db, ctx, async (trx) => {
      const tz = await managerTimeZone(trx, ctx, tzFallback);
      const date = localDate(new Date(), tz);
      const rows = await selectVisits(trx)
        .innerJoin('clients', 'clients.id', 'visits.client_id')
        .select('clients.display_name')
        .where('visits.manager_id', '=', ctx.userId)
        .where('visits.status', 'in', ['planned', 'missed'])
        .where('visits.due_date', '<=', date as never)
        .limit(LIST_LIMIT)
        .execute();
      const items = rows
        .map((r) => ({
          ...toVisit(r),
          clientName: r.display_name,
          overdueDays: Math.max(0, daysBetween(r.due_date_text, date)),
        }))
        .sort(
          (a, b) =>
            b.overdueDays - a.overdueDays ||
            PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose] ||
            a.createdAt.localeCompare(b.createdAt),
        );
      return { items, count: items.length, date, timeZone: tz };
    });
  }

  /** 加一次随访（2.7）：客户和跟进项必须是自己的；日期在今天到 6 个月后之间 */
  create(
    ctx: TenantContext,
    clientId: string,
    input: CreateVisitRequest,
    tzFallback?: string,
  ): Promise<VisitWriteResult> {
    return withTenant(this.db, ctx, async (trx) => {
      // 锁住客户行（共享锁），和并发的转出串行（同 M4 的写入）
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      const tz = await managerTimeZone(trx, ctx, tzFallback);
      if (!dateInRange(input.dueDate, localDate(new Date(), tz))) return 'invalid_date';
      if (input.followUpItemId) {
        const item = await trx
          .selectFrom('follow_up_items')
          .select('id')
          .where('id', '=', input.followUpItemId)
          .where('client_id', '=', clientId)
          .executeTakeFirst();
        if (!item) return 'linked_not_found';
      }
      const created = await trx
        .insertInto('visits')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          due_date: input.dueDate,
          method: input.method,
          purpose: input.followUpItemId && input.purpose === 'adhoc' ? 'follow_up' : input.purpose,
          focus: input.focus || null,
          origin: 'manual',
          follow_up_item_id: input.followUpItemId ?? null,
          created_by: ctx.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return toVisit(
        await selectVisits(trx).where('id', '=', created.id).executeTakeFirstOrThrow(),
      );
    });
  }

  /**
   * 处理随访（2.7）：完成（关联记录或写备注，Q26）、未联系上（顺延，默认 2 天后）、改期、取消（必须选原因）。
   * 已处理的随访 → closed（409）；等方案生效的复评只能取消。
   */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateVisitRequest,
    tzFallback?: string,
  ): Promise<VisitWriteResult> {
    return withTenant(this.db, ctx, async (trx) => {
      const current = await trx
        .selectFrom('visits')
        .select((eb) => ['id', 'client_id', 'status', dateText(eb, 'due_date').as('due')])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found';
      const open = current.status === 'planned' || current.status === 'missed';
      if (!open && !(current.status === 'pending_plan' && input.action === 'cancel')) {
        return 'closed';
      }
      const tz = await managerTimeZone(trx, ctx, tzFallback);
      const today = localDate(new Date(), tz);
      switch (input.action) {
        case 'done': {
          if (input.recordId) {
            const record = await trx
              .selectFrom('visit_records')
              .select('id')
              .where('id', '=', input.recordId)
              .where('client_id', '=', current.client_id)
              .executeTakeFirst();
            if (!record) return 'linked_not_found';
          }
          await trx
            .updateTable('visits')
            .set({
              status: 'done',
              record_id: input.recordId ?? null,
              note: input.note ?? null,
            })
            .where('id', '=', id)
            .execute();
          break;
        }
        case 'missed': {
          const newDate = input.newDate ?? addDays(today, VISIT_MISSED_POSTPONE_DAYS);
          if (!dateInRange(newDate, today) || newDate === current.due) return 'invalid_date';
          await trx
            .updateTable('visits')
            .set({ status: 'missed', due_date: newDate })
            .where('id', '=', id)
            .execute();
          break;
        }
        case 'reschedule': {
          if (!dateInRange(input.newDate, today) || input.newDate === current.due) {
            return 'invalid_date';
          }
          await trx
            .updateTable('visits')
            .set({ status: 'planned', due_date: input.newDate })
            .where('id', '=', id)
            .execute();
          break;
        }
        case 'cancel':
          await trx
            .updateTable('visits')
            .set({
              status: 'cancelled',
              cancel_reason: input.cancelReason,
              note: input.note ?? null,
            })
            .where('id', '=', id)
            .execute();
          break;
      }
      return toVisit(await selectVisits(trx).where('id', '=', id).executeTakeFirstOrThrow());
    });
  }
}

/** 随访日期不能早于今天，不能超过 6 个月后（2.7 第 5 条） */
export function dateInRange(date: string, today: string): boolean {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const max = new Date(Date.UTC(y, m - 1 + VISIT_MAX_AHEAD_MONTHS, d)).toISOString().slice(0, 10);
  return date >= today && date <= max;
}

function selectVisits(trx: TenantTransaction) {
  return trx
    .selectFrom('visits')
    .select((eb) => [
      'visits.id',
      'visits.client_id',
      'visits.method',
      'visits.purpose',
      'visits.focus',
      'visits.origin',
      'visits.status',
      'visits.cancel_reason',
      'visits.note',
      'visits.care_plan_id',
      'visits.follow_up_item_id',
      'visits.record_id',
      'visits.done_at',
      'visits.created_at',
      dateText(eb, 'visits.due_date').as('due_date_text'),
      dateText(eb, 'visits.rescheduled_from').as('rescheduled_from_text'),
    ]);
}

function toVisit(r: {
  id: string;
  client_id: string;
  method: Visit['method'];
  purpose: Visit['purpose'];
  focus: string | null;
  origin: Visit['origin'];
  status: Visit['status'];
  cancel_reason: Visit['cancelReason'];
  note: string | null;
  care_plan_id: string | null;
  follow_up_item_id: string | null;
  record_id: string | null;
  done_at: Date | null;
  created_at: Date;
  due_date_text: string;
  rescheduled_from_text: string | null;
}): Visit {
  return {
    id: r.id,
    clientId: r.client_id,
    dueDate: r.due_date_text,
    method: r.method,
    purpose: r.purpose,
    focus: r.focus,
    origin: r.origin,
    status: r.status,
    cancelReason: r.cancel_reason,
    note: r.note,
    carePlanId: r.care_plan_id,
    followUpItemId: r.follow_up_item_id,
    recordId: r.record_id,
    rescheduledFrom: r.rescheduled_from_text,
    doneAt: iso(r.done_at),
    createdAt: r.created_at.toISOString(),
  };
}
