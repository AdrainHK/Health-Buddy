import { Inject, Injectable } from '@nestjs/common';
import type {
  CheckinMetric,
  CheckinSlot,
  CheckinStatus,
  CompanionAlertCategory,
  CompanionHandoffCategory,
  CompanionScriptKind,
} from '@health-buddy/shared';
import type { CompanionContext, CompanionTurn } from '@health-buddy/skills';
import {
  addPendingReading,
  dueCheckins,
  readingCritical,
  recordCheckin,
  recordCheckinReading,
  sweepCheckins,
  todayCheckins,
  type DueCheckin,
  type ReadingResult,
} from '../../db/companion-checkins.js';
import { deviceProfile, purgeCompanionData } from '../../db/companion-device-auth.js';
import {
  addObservations,
  markRepliesDelivered,
  pendingReplies,
  type NewObservation,
} from '../../db/companion-inbox.js';
import { DB } from '../../db/db.provider.js';
import { withDevice, type Db, type TenantTransaction } from '../../db/database.js';
import type { CompanionMessageSignal } from '../../db/types.js';
import { localDate, zonedDayStart } from '../../twin/time-zone.js';

const TZ = 'Asia/Shanghai';
/** 给模型的本次会话最近几句（规格 5.2） */
const TURNS_FOR_MODEL = 12;

export interface SpokenScript {
  kind: CompanionScriptKind;
  version: number;
  text: string;
}

export interface NewMessage {
  role: 'client' | 'companion';
  kind: 'chat' | 'script';
  scriptKind?: CompanionScriptKind;
  content: string;
  signals?: CompanionMessageSignal[];
}

/**
 * 福宝对话的数据读写（M6 规格 2.2、2.4–2.6、6.2）。全部在 withDevice 事务里：
 * 行级安全只放行当前绑定客户的行，且设备处于已绑定或已开通（暂停、撤回同意后读写不了）。
 * 写入时 client_id 由调用方给出，数据库按 app_client_id() 校验，不一致的会被拒绝。
 */
@Injectable()
export class DialogueRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private run<T>(deviceId: string, fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    return withDevice(this.db, { deviceId }, fn);
  }

  startSession(deviceId: string, clientId: string): Promise<string> {
    return this.run(deviceId, async (trx) => {
      const row = await trx
        .insertInto('companion_sessions')
        .values({ client_id: clientId, device_id: deviceId })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /** 结束会话，返回这次会话客户说了几句 */
  endSession(deviceId: string, clientId: string, sessionId: string): Promise<number> {
    return this.run(deviceId, async (trx) => {
      const count = await trx
        .selectFrom('companion_messages')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('session_id', '=', sessionId)
        .where('role', '=', 'client')
        .executeTakeFirst();
      const turns = Number(count?.n ?? 0);
      await trx
        .updateTable('companion_sessions')
        .set({ ended_at: new Date(), turns })
        .where('id', '=', sessionId)
        .where('client_id', '=', clientId)
        .execute();
      return turns;
    });
  }

  /** 福宝能读的资料（规格 2.6） */
  context(
    deviceId: string,
    clientId: string,
    sessionId: string,
  ): Promise<CompanionContext | undefined> {
    return this.run(deviceId, async (trx) => {
      const profile = await deviceProfile(trx);
      if (!profile) return undefined;
      const deliveries = await trx
        .selectFrom('companion_deliveries')
        .select(['kind', 'content'])
        .orderBy('sent_at', 'desc')
        .execute();
      const memories = await trx
        .selectFrom('companion_memories')
        .select('text')
        .orderBy('created_at', 'desc')
        .limit(30)
        .execute();
      const summaries = await trx
        .selectFrom('companion_sessions')
        .select('summary')
        .where('summary', 'is not', null)
        .where('id', '!=', sessionId)
        .orderBy('started_at', 'desc')
        .limit(3)
        .execute();
      return {
        nameForClient: profile.name_for_client,
        ageBand: profile.age_band,
        nextVisit:
          profile.next_visit_on && profile.next_visit_method
            ? { on: profile.next_visit_on, method: profile.next_visit_method }
            : null,
        deliveries,
        memories: memories.map((m) => m.text),
        recentSummaries: summaries.flatMap((s) => (s.summary ? [s.summary] : [])),
        today: localDate(new Date(), TZ),
        checkins: await todayCheckins(trx, clientId),
      };
    });
  }

  /** 本次会话的对话（时间顺序），最近 limit 句 */
  turns(deviceId: string, sessionId: string, limit = TURNS_FOR_MODEL): Promise<CompanionTurn[]> {
    return this.run(deviceId, async (trx) => {
      const rows = await trx
        .selectFrom('companion_messages')
        .select(['role', 'content'])
        .where('session_id', '=', sessionId)
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.reverse().map((r) => ({ role: r.role, text: r.content }));
    });
  }

  /** 速率（规格 5.4 第 6 条）：最近一分钟、今天（北京时间）客户说了几句 */
  clientTurnCounts(deviceId: string): Promise<{ minute: number; today: number }> {
    return this.run(deviceId, async (trx) => {
      const now = Date.now();
      const dayStart = zonedDayStart(localDate(now, TZ), TZ);
      const row = await trx
        .selectFrom('companion_messages')
        .select((eb) => [
          eb.fn
            .count<string>('id')
            .filterWhere('created_at', '>=', new Date(now - 60_000))
            .as('minute'),
          eb.fn.count<string>('id').as('today'),
        ])
        .where('role', '=', 'client')
        .where('created_at', '>=', dayStart)
        .executeTakeFirst();
      return { minute: Number(row?.minute ?? 0), today: Number(row?.today ?? 0) };
    });
  }

  /** 今天（北京时间）福宝说过“不是医生”没有（N9：开场白或每日开场） */
  saidIntroToday(deviceId: string): Promise<boolean> {
    return this.run(deviceId, async (trx) => {
      const row = await trx
        .selectFrom('companion_messages')
        .select('id')
        .where('script_kind', 'in', ['intro', 'daily_intro'])
        .where('created_at', '>=', zonedDayStart(localDate(new Date(), TZ), TZ))
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  scripts(deviceId: string, kinds: readonly CompanionScriptKind[]): Promise<SpokenScript[]> {
    if (!kinds.length) return Promise.resolve([]);
    return this.run(deviceId, async (trx) => {
      const rows = await trx
        .selectFrom('companion_scripts')
        .distinctOn('kind')
        .select(['kind', 'version', 'text'])
        .where('kind', 'in', [...kinds])
        .orderBy('kind')
        .orderBy('version', 'desc')
        .execute();
      return rows.map((r) => ({
        kind: r.kind as CompanionScriptKind,
        version: r.version,
        text: r.text,
      }));
    });
  }

  /** 写一组消息，返回各自的 id（顺序同输入） */
  addMessages(
    deviceId: string,
    clientId: string,
    sessionId: string,
    messages: readonly NewMessage[],
  ): Promise<string[]> {
    if (!messages.length) return Promise.resolve([]);
    return this.run(deviceId, async (trx) => {
      const ids: string[] = [];
      for (const m of messages) {
        const row = await trx
          .insertInto('companion_messages')
          .values({
            client_id: clientId,
            session_id: sessionId,
            role: m.role,
            kind: m.kind,
            script_kind: m.scriptKind ?? null,
            content: m.content.slice(0, 2000),
            signals: m.signals ?? [],
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        ids.push(row.id);
      }
      return ids;
    });
  }

  addHandoff(
    deviceId: string,
    clientId: string,
    h: {
      messageId: string | null;
      category: CompanionHandoffCategory;
      question: string;
      trigger: 'rule' | 'model' | 'fallback';
    },
  ): Promise<void> {
    return this.run(deviceId, async (trx) => {
      await trx
        .insertInto('companion_handoffs')
        .values({
          client_id: clientId,
          message_id: h.messageId,
          category: h.category,
          question: h.question.slice(0, 500),
          trigger: h.trigger,
        })
        .execute();
    });
  }

  addAlert(
    deviceId: string,
    clientId: string,
    a: {
      messageId: string | null;
      category: CompanionAlertCategory;
      trigger: 'keyword' | 'model';
      scriptVersion: number | null;
    },
  ): Promise<void> {
    return this.run(deviceId, async (trx) => {
      await trx
        .insertInto('companion_alerts')
        .values({
          client_id: clientId,
          message_id: a.messageId,
          category: a.category,
          trigger: a.trigger,
          script_version: a.scriptVersion,
        })
        .execute();
    });
  }

  memories(deviceId: string): Promise<{ id: string; text: string }[]> {
    return this.run(deviceId, (trx) =>
      trx
        .selectFrom('companion_memories')
        .select(['id', 'text'])
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  /**
   * 删除记忆（N11）；ids 为 'all' 时删除这位客户的全部记忆，并清空会话摘要（摘要里可能也有，
   * 不能忘了又被说出来）。显式限定客户，不只靠行级安全（租户审查 S2）
   */
  deleteMemories(
    deviceId: string,
    clientId: string,
    ids: readonly string[] | 'all',
  ): Promise<number> {
    if (ids !== 'all' && !ids.length) return Promise.resolve(0);
    return this.run(deviceId, async (trx) => {
      let q = trx.deleteFrom('companion_memories').where('client_id', '=', clientId);
      if (ids !== 'all') q = q.where('id', 'in', [...ids]);
      const result = await q.executeTakeFirst();
      if (ids === 'all') {
        await trx
          .updateTable('companion_sessions')
          .set({ summary: null })
          .where('client_id', '=', clientId)
          .where('summary', 'is not', null)
          .execute();
      }
      return Number(result.numDeletedRows);
    });
  }

  /** 后台整理的结果：新记忆和会话摘要 */
  saveSessionDigest(
    deviceId: string,
    clientId: string,
    sessionId: string,
    digest: { memories: readonly string[]; summary: string | null },
  ): Promise<void> {
    return this.run(deviceId, async (trx) => {
      for (const text of digest.memories) {
        await trx
          .insertInto('companion_memories')
          .values({ client_id: clientId, text, source_session_id: sessionId })
          .execute();
      }
      await trx
        .updateTable('companion_sessions')
        .set({ summary: digest.summary, summarized_at: new Date() })
        .where('id', '=', sessionId)
        .where('client_id', '=', clientId)
        .execute();
    });
  }

  purge(): Promise<{ messages: number; memories: number }> {
    return purgeCompanionData(this.db);
  }

  // ---------- 打卡（规格 2.3）：都经数据库函数，计划、时间段、客户由函数校验 ----------

  dueCheckins(deviceId: string, clientId: string): Promise<DueCheckin[]> {
    return this.run(deviceId, (trx) => dueCheckins(trx, clientId));
  }

  recordCheckin(
    deviceId: string,
    clientId: string,
    planId: string,
    slot: CheckinSlot,
    status: CheckinStatus,
  ): Promise<string | null> {
    return this.run(deviceId, (trx) => recordCheckin(trx, clientId, planId, slot, status));
  }

  recordReading(
    deviceId: string,
    clientId: string,
    planId: string,
    slot: CheckinSlot,
    values: readonly number[],
  ): Promise<ReadingResult> {
    return this.run(deviceId, (trx) => recordCheckinReading(trx, clientId, planId, slot, values));
  }

  readingCritical(
    deviceId: string,
    metric: CheckinMetric,
    values: readonly number[],
  ): Promise<boolean> {
    return this.run(deviceId, (trx) => readingCritical(trx, metric, values));
  }

  addPendingReading(
    deviceId: string,
    clientId: string,
    metric: CheckinMetric,
    values: readonly number[],
    text: string,
    messageId: string | null,
  ): Promise<void> {
    return this.run(deviceId, (trx) =>
      addPendingReading(trx, clientId, metric, values, text, messageId),
    );
  }

  // ---------- 转交回复、收集信息（第 6 步） ----------

  /** 健管师已回复、还没播报的回复原文（N13） */
  pendingReplies(deviceId: string, clientId: string): Promise<{ id: string; text: string }[]> {
    return this.run(deviceId, (trx) => pendingReplies(trx, clientId));
  }

  markRepliesDelivered(
    deviceId: string,
    clientId: string,
    ids: readonly string[],
  ): Promise<number> {
    if (!ids.length) return Promise.resolve(0);
    return this.run(deviceId, (trx) => markRepliesDelivered(trx, clientId, ids));
  }

  /** 会话结束整理出的收集信息（规格 2.7） */
  addObservations(
    deviceId: string,
    clientId: string,
    sessionId: string,
    items: readonly NewObservation[],
  ): Promise<number> {
    if (!items.length) return Promise.resolve(0);
    return this.run(deviceId, (trx) => addObservations(trx, clientId, sessionId, items));
  }

  /** 定时任务：窗口过了没回答的记“未应答” */
  sweepCheckins(): Promise<number> {
    return sweepCheckins(this.db);
  }
}
