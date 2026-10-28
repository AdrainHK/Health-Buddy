import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';

/**
 * M6 伴侣设备用到的数据库函数（规格 3.2、6.2）。原始 SQL 只放在 db 目录里。
 * 设备的绑定、解绑、暂停只能经这些 SECURITY DEFINER 函数；函数里重新校验当前健管师服务这位客户。
 * 只在已经设置了租户上下文的事务里调用。
 */

export interface BindingCandidate {
  id: string;
  status: string;
  activation_code_hash: string;
}

/** 按序列号取设备和激活码哈希（只给健管师；不返回设备属于谁） */
export async function companionDeviceForBinding(
  trx: TenantTransaction,
  serialNo: string,
): Promise<BindingCandidate | undefined> {
  const { rows } = await sql<BindingCandidate>`
    select id, status, activation_code_hash from companion_device_for_binding(${serialNo})
  `.execute(trx);
  return rows[0];
}

/** ok / not_found / already_bound / no_consent / unavailable */
export async function bindCompanionDevice(
  trx: TenantTransaction,
  deviceId: string,
  clientId: string,
): Promise<string> {
  const { rows } = await sql<{ r: string }>`
    select bind_companion_device(${deviceId}::uuid, ${clientId}::uuid) as r
  `.execute(trx);
  return rows[0]?.r ?? 'not_found';
}

/** ok / not_found / no_device */
export async function unbindCompanionDevice(
  trx: TenantTransaction,
  clientId: string,
): Promise<string> {
  const { rows } = await sql<{ r: string }>`
    select unbind_companion_device(${clientId}::uuid) as r
  `.execute(trx);
  return rows[0]?.r ?? 'not_found';
}

/** ok / not_found / no_device / invalid_state */
export async function setCompanionDevicePaused(
  trx: TenantTransaction,
  clientId: string,
  paused: boolean,
): Promise<string> {
  const { rows } = await sql<{ r: string }>`
    select set_companion_device_paused(${clientId}::uuid, ${paused}) as r
  `.execute(trx);
  return rows[0]?.r ?? 'not_found';
}

/** 已存在的序列号（只给平台管理员） */
export async function companionExistingSerials(
  trx: TenantTransaction,
  serials: string[],
): Promise<string[]> {
  const { rows } = await sql<{ s: string }>`
    select s from companion_existing_serials(${serials}::text[]) as s
  `.execute(trx);
  return rows.map((r) => r.s);
}

export interface DeviceBatchStatsRow {
  id: string;
  name: string;
  device_count: number;
  bound_count: number;
  imported_at: Date;
}

/** 每批的数量和绑定数（只给平台管理员；不含客户） */
export async function companionDeviceBatchStats(
  trx: TenantTransaction,
): Promise<DeviceBatchStatsRow[]> {
  const { rows } = await sql<DeviceBatchStatsRow>`
    select * from companion_device_batch_stats()
  `.execute(trx);
  return rows;
}
