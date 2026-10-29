import type { CheckinMetric, ObservationCategory } from '@health-buddy/shared';
import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/**
 * 转交、预警、收集信息用到的数据库函数（M6 第 6 步，迁移 0029）。原始 SQL 只放在 db 目录里。
 * 设备会话的函数带会话开始时的客户，必须等于设备当前绑定的客户；健管师的函数按 app_user_id() 校验。
 */

export interface NewObservation {
  category: ObservationCategory;
  text: string;
  polarity: 'negative' | 'neutral' | 'positive' | null;
  metric: CheckinMetric | null;
  values: number[];
}

/** 会话结束整理出的收集信息（设备会话） */
export async function addObservations(
  trx: TenantTransaction,
  clientId: string,
  sessionId: string,
  items: readonly NewObservation[],
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select companion_add_observations(${clientId}::uuid, ${sessionId}::uuid, ${JSON.stringify(items)}::jsonb) as n
  `.execute(trx);
  return Number(rows[0]?.n ?? 0);
}

/** 健管师确认（写监测）或驳回待确认的测量；不是自己的、不是待确认的时抛错（P0002） */
export async function resolveObservation(
  trx: TenantTransaction,
  id: string,
  confirm: boolean,
): Promise<boolean> {
  const { rows } = await sql<{ written: boolean }>`
    select companion_observation_resolve(${id}::uuid, ${confirm}) as written
  `.execute(trx);
  return rows[0]?.written === true;
}

/** 已回复、还没播报的回复原文（设备会话） */
export async function pendingReplies(
  trx: TenantTransaction,
  clientId: string,
): Promise<{ id: string; text: string }[]> {
  const { rows } = await sql<{ id: string; reply_text: string }>`
    select id, reply_text from companion_pending_replies(${clientId}::uuid)
  `.execute(trx);
  return rows.map((r) => ({ id: r.id, text: r.reply_text }));
}

export async function markRepliesDelivered(
  trx: TenantTransaction,
  clientId: string,
  ids: readonly string[],
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select companion_mark_replies_delivered(${clientId}::uuid, ${[...ids]}::uuid[]) as n
  `.execute(trx);
  return Number(rows[0]?.n ?? 0);
}

/** 健管师对“设备离线”点“知道了”；不是自己的客户时返回 false */
export async function offlineAck(trx: TenantTransaction, clientId: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select companion_offline_ack(${clientId}::uuid) as ok
  `.execute(trx);
  return rows[0]?.ok === true;
}
