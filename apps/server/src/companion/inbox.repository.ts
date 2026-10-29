import { Inject, Injectable } from '@nestjs/common';
import {
  COMPANION_HANDOFF_OVERDUE_MS,
  COMPANION_OFFLINE_REMIND_MS,
  COMPANION_SESSIONS_PAGE,
  type AlertResolution,
  type CompanionAlert,
  type CompanionHandoff,
  type CompanionInboxResponse,
  type CompanionMemory,
  type CompanionObservation,
  type CompanionSession,
} from '@health-buddy/shared';
import { dateText, iso } from '../care/common.js';
import { offlineAck, resolveObservation } from '../db/companion-inbox.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { ownClient } from '../twin/twin.repository.js';

/**
 * 健管师处理福宝的转交、预警、待确认的测量，查看收集信息、聊天和记忆（M6 第 6 步）。
 * 只有服务这位客户的健管师：行级安全 + 显式限定本人；状态流转由数据库触发器和函数校验。
 * 文字只回给健管师，不进日志。
 */

export type CaseResult<T> = T | 'not_found' | 'invalid_state';

const OPEN_LIST_LIMIT = 100;
const CLIENT_CASES_LIMIT = 50;

type Tx = TenantTransaction;

@Injectable()
export class InboxRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 今日跟进“伴侣”分组：未处理的预警、转交、待确认的测量、离线设备 */
  inbox(ctx: TenantContext): Promise<CompanionInboxResponse> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') {
        return { alerts: [], handoffs: [], pendingReadings: [], offlineDevices: [] };
      }
      const alerts = await alertQuery(trx, ctx)
        .where('a.status', '=', 'open')
        .orderBy('a.created_at', 'desc')
        .limit(OPEN_LIST_LIMIT)
        .execute();
      const handoffs = await handoffQuery(trx, ctx)
        .where('h.status', '=', 'open')
        .orderBy('h.created_at')
        .limit(OPEN_LIST_LIMIT)
        .execute();
      const pending = await observationQuery(trx, ctx)
        .innerJoin('clients as c', 'c.id', 'o.client_id')
        .select('c.display_name')
        .where('o.status', '=', 'pending_confirm')
        .orderBy('o.created_at')
        .limit(OPEN_LIST_LIMIT)
        .execute();
      const cutoff = new Date(Date.now() - COMPANION_OFFLINE_REMIND_MS);
      const offline = await trx
        .selectFrom('companion_devices as d')
        .innerJoin('clients as c', 'c.id', 'd.client_id')
        .select(['d.client_id', 'd.last_seen_at', 'c.display_name'])
        .where('d.manager_id', '=', ctx.userId)
        .where('d.status', '=', 'active')
        .where((eb) => eb.or([eb('d.last_seen_at', 'is', null), eb('d.last_seen_at', '<', cutoff)]))
        // 点过“知道了”之后没有再上线的不再提醒
        .where((eb) =>
          eb.or([
            eb('d.offline_ack_at', 'is', null),
            eb('d.offline_ack_at', '<', eb.fn.coalesce('d.last_seen_at', eb.val(new Date(0)))),
          ]),
        )
        .orderBy('d.last_seen_at')
        .execute();
      const now = Date.now();
      return {
        alerts: alerts.map(toAlert),
        // 超时的在前
        handoffs: handoffs
          .map((h) => toHandoff(h, now))
          .sort((a, b) => Number(b.overdue) - Number(a.overdue)),
        pendingReadings: pending.map((o) => ({ ...toObservation(o), clientName: o.display_name })),
        offlineDevices: offline.map((d) => ({
          clientId: d.client_id!,
          clientName: d.display_name,
          lastSeenAt: iso(d.last_seen_at),
        })),
      };
    });
  }

  /** 一位客户的预警和转交（含已处理的，最近的在前） */
  clientCases(
    ctx: TenantContext,
    clientId: string,
  ): Promise<{ alerts: CompanionAlert[]; handoffs: CompanionHandoff[] } | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const alerts = await alertQuery(trx, ctx)
        .where('a.client_id', '=', clientId)
        .orderBy('a.created_at', 'desc')
        .limit(CLIENT_CASES_LIMIT)
        .execute();
      const handoffs = await handoffQuery(trx, ctx)
        .where('h.client_id', '=', clientId)
        .orderBy('h.created_at', 'desc')
        .limit(CLIENT_CASES_LIMIT)
        .execute();
      const now = Date.now();
      return { alerts: alerts.map(toAlert), handoffs: handoffs.map((h) => toHandoff(h, now)) };
    });
  }

  handleAlert(
    ctx: TenantContext,
    alertId: string,
    resolution: AlertResolution,
    note: string | null,
  ): Promise<CaseResult<CompanionAlert>> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return 'not_found';
      const current = await trx
        .selectFrom('companion_alerts')
        .select('status')
        .where('id', '=', alertId)
        .where('manager_id', '=', ctx.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found';
      if (current.status !== 'open') return 'invalid_state';
      await trx
        .updateTable('companion_alerts')
        .set({ status: 'handled', resolution, note })
        .where('id', '=', alertId)
        .where('manager_id', '=', ctx.userId)
        .execute();
      const row = await alertQuery(trx, ctx).where('a.id', '=', alertId).executeTakeFirstOrThrow();
      return toAlert(row);
    });
  }

  /** 健管师直接写回复（内容检查在调用方）；只有未处理的能回复 */
  replyHandoff(
    ctx: TenantContext,
    handoffId: string,
    text: string,
  ): Promise<CaseResult<CompanionHandoff>> {
    return this.updateHandoff(ctx, handoffId, ['open'], { status: 'replied', reply_text: text });
  }

  /** 已电话联系或关闭；未处理、已回复（还没播报）的都可以 */
  closeHandoff(
    ctx: TenantContext,
    handoffId: string,
    outcome: 'closed_by_call' | 'closed',
  ): Promise<CaseResult<CompanionHandoff>> {
    return this.updateHandoff(ctx, handoffId, ['open', 'replied'], { status: outcome });
  }

  private updateHandoff(
    ctx: TenantContext,
    handoffId: string,
    from: readonly string[],
    set: { status: 'replied' | 'closed_by_call' | 'closed'; reply_text?: string },
  ): Promise<CaseResult<CompanionHandoff>> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return 'not_found';
      const current = await trx
        .selectFrom('companion_handoffs')
        .select('status')
        .where('id', '=', handoffId)
        .where('manager_id', '=', ctx.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return 'not_found';
      if (!from.includes(current.status)) return 'invalid_state';
      await trx
        .updateTable('companion_handoffs')
        .set(set)
        .where('id', '=', handoffId)
        .where('manager_id', '=', ctx.userId)
        .execute();
      const row = await handoffQuery(trx, ctx)
        .where('h.id', '=', handoffId)
        .executeTakeFirstOrThrow();
      return toHandoff(row, Date.now());
    });
  }

  /** 收集信息（最近的在前，最多 200 条） */
  observations(ctx: TenantContext, clientId: string): Promise<CompanionObservation[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const rows = await observationQuery(trx, ctx)
        .where('o.client_id', '=', clientId)
        .orderBy('o.created_at', 'desc')
        .limit(200)
        .execute();
      return rows.map(toObservation);
    });
  }

  /**
   * 确认（写监测）或驳回待确认的测量；返回更新后的条目和所属客户（确认后要让孪生重算）。
   * 不是自己的、已经处理过的都按 not_found（数据库函数统一报 P0002）
   */
  resolveObservation(
    ctx: TenantContext,
    id: string,
    confirm: boolean,
  ): Promise<{ observation: CompanionObservation; written: boolean } | 'not_found'> {
    return withTenant(this.db, ctx, async (trx) => {
      if (ctx.role !== 'manager') return 'not_found';
      const own = await trx
        .selectFrom('companion_observations')
        .select('id')
        .where('id', '=', id)
        .where('manager_id', '=', ctx.userId)
        .where('status', '=', 'pending_confirm')
        .executeTakeFirst();
      if (!own) return 'not_found';
      const written = await resolveObservation(trx, id, confirm);
      const row = await observationQuery(trx, ctx).where('o.id', '=', id).executeTakeFirstOrThrow();
      return { observation: toObservation(row), written };
    });
  }

  /** 聊天（按会话，最近的在前）；before 是上一页最后一个会话的开始时间 */
  sessions(
    ctx: TenantContext,
    clientId: string,
    before: Date | null,
  ): Promise<{ sessions: CompanionSession[]; next: string | null } | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      let q = trx
        .selectFrom('companion_sessions')
        .select(['id', 'started_at', 'ended_at', 'summary'])
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId);
      if (before) q = q.where('started_at', '<', before);
      const rows = await q
        .orderBy('started_at', 'desc')
        .limit(COMPANION_SESSIONS_PAGE + 1)
        .execute();
      const page = rows.slice(0, COMPANION_SESSIONS_PAGE);
      const messages = page.length
        ? await trx
            .selectFrom('companion_messages')
            .select(['id', 'session_id', 'role', 'kind', 'content', 'created_at'])
            .where('client_id', '=', clientId)
            .where('manager_id', '=', ctx.userId)
            .where(
              'session_id',
              'in',
              page.map((s) => s.id),
            )
            .orderBy('id')
            .execute()
        : [];
      return {
        sessions: page.map((s) => ({
          id: s.id,
          startedAt: s.started_at.toISOString(),
          endedAt: iso(s.ended_at),
          summary: s.summary,
          messages: messages
            .filter((m) => m.session_id === s.id)
            .map((m) => ({
              id: String(m.id),
              role: m.role,
              kind: m.kind,
              content: m.content,
              createdAt: m.created_at.toISOString(),
            })),
        })),
        next: rows.length > COMPANION_SESSIONS_PAGE ? page.at(-1)!.started_at.toISOString() : null,
      };
    });
  }

  memories(ctx: TenantContext, clientId: string): Promise<CompanionMemory[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('companion_memories')
        .select(['id', 'text', 'created_at'])
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((m) => ({ id: m.id, text: m.text, createdAt: m.created_at.toISOString() }));
    });
  }

  /** 删除一条记忆（N10、N11）；不是自己客户的、不存在的都是 false（404） */
  deleteMemory(ctx: TenantContext, clientId: string, memoryId: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return false;
      const result = await trx
        .deleteFrom('companion_memories')
        .where('id', '=', memoryId)
        .where('client_id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }

  offlineAck(ctx: TenantContext, clientId: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return false;
      return offlineAck(trx, clientId);
    });
  }
}

// ---------- 查询 ----------

function alertQuery(trx: Tx, ctx: TenantContext) {
  return trx
    .selectFrom('companion_alerts as a')
    .innerJoin('clients as c', 'c.id', 'a.client_id')
    .leftJoin('companion_messages as m', (j) =>
      j.onRef('m.id', '=', 'a.message_id').onRef('m.client_id', '=', 'a.client_id'),
    )
    .leftJoin('companion_scripts as s', (j) =>
      j.onRef('s.kind', '=', 'a.category').onRef('s.version', '=', 'a.script_version'),
    )
    .select([
      'a.id',
      'a.client_id',
      'c.display_name',
      'a.category',
      'a.trigger',
      'm.content as said',
      's.text as companion_said',
      'a.status',
      'a.resolution',
      'a.note',
      'a.handled_at',
      'a.created_at',
    ])
    .where('a.manager_id', '=', ctx.userId);
}

function handoffQuery(trx: Tx, ctx: TenantContext) {
  return trx
    .selectFrom('companion_handoffs as h')
    .innerJoin('clients as c', 'c.id', 'h.client_id')
    .select([
      'h.id',
      'h.client_id',
      'c.display_name',
      'h.category',
      'h.question',
      'h.status',
      'h.reply_text',
      'h.replied_at',
      'h.delivered_at',
      'h.closed_at',
      'h.created_at',
    ])
    .where('h.manager_id', '=', ctx.userId);
}

function observationQuery(trx: Tx, ctx: TenantContext) {
  return trx
    .selectFrom('companion_observations as o')
    .select((eb) => [
      'o.id',
      'o.client_id',
      'o.category',
      'o.polarity',
      'o.text',
      dateText(eb, 'o.observed_on').as('observed_on'),
      'o.metric',
      'o.reading_values',
      'o.status',
      'o.created_at',
    ])
    .where('o.manager_id', '=', ctx.userId);
}

type AlertRow = Awaited<ReturnType<ReturnType<typeof alertQuery>['executeTakeFirstOrThrow']>>;
type HandoffRow = Awaited<ReturnType<ReturnType<typeof handoffQuery>['executeTakeFirstOrThrow']>>;
type ObservationRow = Awaited<
  ReturnType<ReturnType<typeof observationQuery>['executeTakeFirstOrThrow']>
>;

function toAlert(r: AlertRow): CompanionAlert {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.display_name,
    category: r.category,
    trigger: r.trigger,
    said: r.said ?? null,
    companionSaid: r.companion_said ?? null,
    status: r.status,
    resolution: r.resolution,
    note: r.note,
    handledAt: iso(r.handled_at),
    createdAt: r.created_at.toISOString(),
  };
}

function toHandoff(r: HandoffRow, now: number): CompanionHandoff {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.display_name,
    category: r.category,
    question: r.question,
    status: r.status,
    replyText: r.reply_text,
    repliedAt: iso(r.replied_at),
    deliveredAt: iso(r.delivered_at),
    closedAt: iso(r.closed_at),
    createdAt: r.created_at.toISOString(),
    overdue: r.status === 'open' && now - r.created_at.getTime() > COMPANION_HANDOFF_OVERDUE_MS,
  };
}

function toObservation(r: ObservationRow): CompanionObservation {
  return {
    id: r.id,
    clientId: r.client_id,
    category: r.category as CompanionObservation['category'],
    polarity: r.polarity,
    text: r.text,
    observedOn: r.observed_on,
    metric: r.metric,
    values: r.reading_values.map(Number),
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}
