import { Inject, Injectable } from '@nestjs/common';
import {
  compareFollowUps,
  type FollowUpItem,
  type FollowUpListQuery,
  type FollowUpListResponse,
  type UpdateFollowUpRequest,
} from '@health-buddy/shared';
import type { ExpressionBuilder } from 'kysely';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import type { Database } from '../db/types.js';
import { addDays, daysBetween, localDate, zonedDayStart } from './time-zone.js';
import { clientVisible } from './twin.repository.js';

const LIST_LIMIT = 500;

type ItemRow = {
  id: string;
  client_id: string;
  display_name: string;
  kind: FollowUpItem['kind'];
  severity: number;
  domain: FollowUpItem['domain'];
  metric: string | null;
  basis: unknown;
  status: FollowUpItem['status'];
  snooze_until: Date | null;
  resolution: FollowUpItem['resolution'];
  dismiss_reason: FollowUpItem['dismissReason'];
  note: string | null;
  first_triggered_at: Date;
  last_triggered_at: Date;
  resolved_at: Date | null;
  consulted_at: Date | string | null;
};

function itemColumns(eb: ExpressionBuilder<Database, 'follow_up_items' | 'clients'>) {
  return [
    'follow_up_items.id',
    'follow_up_items.client_id',
    'clients.display_name',
    'follow_up_items.kind',
    'follow_up_items.severity',
    'follow_up_items.domain',
    'follow_up_items.metric',
    'follow_up_items.basis',
    'follow_up_items.status',
    'follow_up_items.snooze_until',
    'follow_up_items.resolution',
    'follow_up_items.dismiss_reason',
    'follow_up_items.note',
    'follow_up_items.first_triggered_at',
    'follow_up_items.last_triggered_at',
    'follow_up_items.resolved_at',
    eb
      .selectFrom('follow_up_events as e')
      .select((e) => e.fn.max('e.created_at').as('t'))
      .whereRef('e.item_id', '=', 'follow_up_items.id')
      .where('e.action', '=', 'consulted')
      .as('consulted_at'),
  ] as const;
}

function selectItems(trx: TenantTransaction) {
  return trx
    .selectFrom('follow_up_items')
    .innerJoin('clients', 'clients.id', 'follow_up_items.client_id')
    .select(itemColumns);
}

function toItem(row: ItemRow, date: string, tz: string): FollowUpItem {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.display_name,
    kind: row.kind,
    severity: row.severity as FollowUpItem['severity'],
    domain: row.domain,
    metric: row.metric,
    basis: (row.basis && typeof row.basis === 'object' ? row.basis : {}) as Record<string, unknown>,
    status: row.status,
    snoozeUntil: row.snooze_until?.toISOString() ?? null,
    resolution: row.resolution,
    dismissReason: row.dismiss_reason,
    note: row.note,
    firstTriggeredAt: row.first_triggered_at.toISOString(),
    lastTriggeredAt: row.last_triggered_at.toISOString(),
    carriedDays: Math.max(0, daysBetween(localDate(row.first_triggered_at, tz), date)),
    consultedAt: row.consulted_at ? new Date(row.consulted_at).toISOString() : null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

export type UpdateFollowUpResult = FollowUpItem | 'not_found' | 'critical' | 'conflict';

/**
 * 今日跟进清单（M4 规格 2.6，Q11–Q15）。跟进项只有健管师本人能看和处理（行级安全，Q20）；
 * 客户转出后跟进项跟着客户走，原健管师查不到（Q23）。“今日”按健管师的时区（Q13）。
 */
@Injectable()
export class FollowUpsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 账号设置的时区优先，其次浏览器时区，都没有时用 UTC */
  private async timeZone(trx: TenantTransaction, ctx: TenantContext, fallback?: string) {
    const row = await trx
      .selectFrom('users')
      .select('timezone')
      .where('id', '=', ctx.userId)
      .executeTakeFirst();
    return row?.timezone ?? fallback ?? 'UTC';
  }

  /** clientId 不是自己的客户时返回 undefined（404） */
  list(ctx: TenantContext, query: FollowUpListQuery): Promise<FollowUpListResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (query.clientId && !(await clientVisible(trx, query.clientId))) return undefined;
      const tz = await this.timeZone(trx, ctx, query.tz);
      const date = query.date ?? localDate(new Date(), tz);
      const dayEnd = zonedDayStart(addDays(date, 1), tz);

      let q = selectItems(trx)
        .where('follow_up_items.manager_id', '=', ctx.userId)
        .where('follow_up_items.first_triggered_at', '<', dayEnd);
      if (query.clientId) q = q.where('follow_up_items.client_id', '=', query.clientId);
      const active = (qb: typeof q) =>
        qb.where((eb) =>
          eb.or([
            eb('follow_up_items.status', '=', 'open'),
            eb.and([
              eb('follow_up_items.status', '=', 'snoozed'),
              eb('follow_up_items.snooze_until', '<', dayEnd),
            ]),
          ]),
        );
      const filtered =
        query.status === 'active'
          ? active(q)
          : q.where('follow_up_items.status', '=', query.status);
      const rows = await filtered
        .orderBy('follow_up_items.severity')
        .orderBy('follow_up_items.last_triggered_at', 'desc')
        .limit(LIST_LIMIT)
        .execute();
      const openCount =
        query.status === 'active' ? rows.length : (await active(q).execute()).length;
      return {
        items: rows.map((r) => toItem(r as ItemRow, date, tz)).sort(compareFollowUps),
        openCount,
        date,
        timeZone: tz,
      };
    });
  }

  /**
   * 处理跟进项（Q14）：已处理、暂缓（明天、3 天后、7 天后，按健管师时区的 0 点）、忽略、重新打开。
   * 危急类不能忽略 → 'critical'（400）；状态不允许（如已处理的再暂缓）或重新打开时已有同类未处理项 → 'conflict'。
   */
  update(
    ctx: TenantContext,
    itemId: string,
    input: UpdateFollowUpRequest,
    tzFallback: string | undefined,
  ): Promise<UpdateFollowUpResult> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return 'not_found';
      const current = await trx
        .selectFrom('follow_up_items')
        .select(['id', 'kind', 'status', 'client_id', 'dedupe_key'])
        .where('id', '=', itemId)
        .where('manager_id', '=', ctx.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found';
      if (input.action === 'dismiss' && current.kind === 'critical') return 'critical';
      const unresolved = current.status === 'open' || current.status === 'snoozed';
      const tz = await this.timeZone(trx, ctx, tzFallback);

      let set: Record<string, unknown>;
      switch (input.action) {
        case 'done':
          if (!unresolved) return 'conflict';
          set = {
            status: 'done',
            resolution: input.resolution ?? null,
            note: input.note || null,
            snooze_until: null,
          };
          break;
        case 'snooze': {
          if (!unresolved) return 'conflict';
          const target = addDays(localDate(new Date(), tz), input.snoozeDays);
          set = {
            status: 'snoozed',
            snooze_until: zonedDayStart(target, tz),
            ...(input.note !== undefined ? { note: input.note || null } : {}),
          };
          break;
        }
        case 'dismiss':
          if (!unresolved) return 'conflict';
          set = {
            status: 'dismissed',
            dismiss_reason: input.dismissReason,
            note: input.note || null,
            snooze_until: null,
          };
          break;
        case 'reopen':
          if (current.status === 'open') return 'conflict';
          if (current.status !== 'snoozed') {
            const other = await trx
              .selectFrom('follow_up_items')
              .select('id')
              .where('client_id', '=', current.client_id)
              .where('dedupe_key', '=', current.dedupe_key)
              .where('status', 'in', ['open', 'snoozed'])
              .executeTakeFirst();
            if (other) return 'conflict';
          }
          set = { status: 'open', snooze_until: null };
          break;
      }
      try {
        await trx
          .updateTable('follow_up_items')
          .set(set)
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow();
      } catch (err) {
        // 重新打开时已有同一类型、同一指标的未处理项（部分唯一索引）
        if ((err as { code?: string }).code === '23505') return 'conflict';
        throw err;
      }
      const row = await selectItems(trx)
        .where('follow_up_items.id', '=', itemId)
        .executeTakeFirstOrThrow();
      return toItem(row as ItemRow, localDate(new Date(), tz), tz);
    });
  }
}
