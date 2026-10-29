import { sql } from 'kysely';
import type { Db, TenantTransaction } from './database.js';

/**
 * 伴侣设备认证和计量用到的数据库函数（M6 规格 3.2、3.4，迁移 0026）。
 * 这些函数只在没有租户上下文的连接上可用（设备此时还没有身份），所以直接在连接池上调用，
 * 不放进 withTenant / withDevice 事务。原始 SQL 只放在 db 目录里。
 */

export interface DeviceAuthRow {
  id: string;
  status: 'stock' | 'bound' | 'active' | 'paused' | 'revoked';
  secret_encrypted: Buffer | null;
}

export async function deviceAuthLookup(
  db: Db,
  serialNo: string,
): Promise<DeviceAuthRow | undefined> {
  const { rows } = await sql<DeviceAuthRow>`
    select id, status, secret_encrypted from companion_device_auth_lookup(${serialNo})
  `.execute(db);
  return rows[0];
}

/** 发一个待验证的令牌；设备没有绑定时 false */
export async function issueDeviceToken(
  db: Db,
  deviceId: string,
  tokenHash: Buffer,
  challenge: string,
  ttlSeconds: number,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select companion_device_token_issue(${deviceId}::uuid, ${tokenHash}, ${challenge}, ${ttlSeconds}) as ok
  `.execute(db);
  return rows[0]?.ok === true;
}

/** HMAC 验证通过后启用令牌；挑战不存在或超时时 false */
export async function activateDeviceToken(
  db: Db,
  deviceId: string,
  challenge: string,
  firmware: string | null,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select companion_device_token_activate(${deviceId}::uuid, ${challenge}, ${firmware}) as ok
  `.execute(db);
  return rows[0]?.ok === true;
}

export interface DeviceConnection {
  device_id: string;
  status: 'bound' | 'active' | 'paused' | 'revoked';
  first_connection: boolean;
}

/** 语音通道连接时按令牌哈希认证；令牌无效时 undefined */
export async function connectDevice(
  db: Db,
  tokenHash: Buffer,
): Promise<DeviceConnection | undefined> {
  const { rows } = await sql<DeviceConnection>`
    select device_id, status, first_connection from companion_device_connect(${tokenHash})
  `.execute(db);
  return rows[0];
}

export async function markDeviceSeen(db: Db, deviceId: string): Promise<void> {
  await sql`select companion_device_seen(${deviceId}::uuid)`.execute(db);
}

export interface CompanionUsage {
  deviceId: string;
  route: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  outcome: string;
  errorType: string | null;
}

/** 伴侣调用的计量（Q29）：协会从设备行取 */
export async function recordCompanionUsage(db: Db, u: CompanionUsage): Promise<void> {
  await sql`
    select record_companion_llm_usage(
      ${u.deviceId}::uuid, ${u.route}, ${u.provider}, ${u.model}, ${u.inputTokens}, ${u.outputTokens},
      ${u.costUsd === null ? null : String(u.costUsd)}::numeric, ${u.durationMs}, ${u.outcome},
      ${u.errorType}
    )
  `.execute(db);
}

export interface DeviceSettingsRow {
  name_for_client: string | null;
  voice_speed: 'slow' | 'medium' | 'fast';
  volume: 'low' | 'medium' | 'high';
}

/** 设备会话里读当前客户的伴侣设置（只在 withDevice 事务里调用）；没有绑定客户时 undefined */
export async function deviceSettings(
  trx: TenantTransaction,
): Promise<DeviceSettingsRow | undefined> {
  const { rows } = await sql<DeviceSettingsRow>`
    select name_for_client, voice_speed, volume from companion_device_settings()
  `.execute(trx);
  return rows[0];
}

export interface DeviceProfileRow {
  name_for_client: string | null;
  age_band: string | null;
  next_visit_on: string | null;
  next_visit_method: 'phone' | 'wechat' | 'in_person' | 'video' | null;
}

/** 设备会话里读福宝能读的客户资料（规格 2.6，迁移 0027）；只在 withDevice 事务里调用 */
export async function deviceProfile(trx: TenantTransaction): Promise<DeviceProfileRow | undefined> {
  const { rows } = await sql<DeviceProfileRow>`
    select name_for_client, age_band, to_char(next_visit_on, 'YYYY-MM-DD') as next_visit_on,
      next_visit_method
    from companion_device_profile()
  `.execute(trx);
  return rows[0];
}

/** 定时清理到期的聊天文字和记忆（N19、Q5）；没有租户上下文时调用 */
export async function purgeCompanionData(db: Db): Promise<{ messages: number; memories: number }> {
  const { rows } = await sql<{ messages: number; memories: number }>`
    select messages, memories from companion_purge()
  `.execute(db);
  return rows[0] ?? { messages: 0, memories: 0 };
}
