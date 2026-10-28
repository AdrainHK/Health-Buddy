import { Inject, Injectable } from '@nestjs/common';
import {
  COMPANION_ONLINE_WINDOW_MS,
  companionStatusOf,
  serialLast4,
  type BindCompanionDeviceRequest,
  type CompanionConsent,
  type CompanionDevice,
  type CompanionOverview,
  type RecordCompanionConsentRequest,
  type RevokeCompanionConsentRequest,
  type UpdateCompanionSettingsRequest,
} from '@health-buddy/shared';
import { sql } from 'kysely';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { dateText, iso, managerTimeZone } from '../care/common.js';
import { localDate } from '../twin/time-zone.js';
import { ownClient } from '../twin/twin.repository.js';
import { verifyActivationCode, verifyAgainstDummyCode } from './device-credentials.js';

/**
 * 健管师端的伴侣设备、线下告知和同意、伴侣设置（M6 规格 2.1、2.8、6.4）。
 * 只有服务这位客户的健管师能看和操作（行级安全 + 显式限定本人）；设备的绑定、解绑、暂停
 * 只经数据库函数。激活码不进日志；序列号只返回后 4 位。
 */

export type BindResult =
  CompanionOverview | 'not_found' | 'already_bound' | 'no_consent' | 'unavailable';
export type DeviceActionResult = CompanionOverview | 'not_found' | 'no_device' | 'invalid_state';
export type ConsentResult =
  CompanionOverview | 'not_found' | 'unknown_notice' | 'future_date' | 'not_consented';

@Injectable()
export class CompanionRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 伴侣视图概览；不是自己的客户时 undefined（404） */
  overview(ctx: TenantContext, clientId: string): Promise<CompanionOverview | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      return loadOverview(trx, ctx, clientId);
    });
  }

  updateSettings(
    ctx: TenantContext,
    clientId: string,
    body: UpdateCompanionSettingsRequest,
  ): Promise<CompanionOverview | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return undefined;
      const set: Record<string, string | null> = {};
      if (body.nameForClient !== undefined) set.companion_name_for_client = body.nameForClient;
      if (body.voiceSpeed) set.companion_voice_speed = body.voiceSpeed;
      if (body.volume) set.companion_volume = body.volume;
      await trx
        .updateTable('clients')
        .set(set)
        .where('id', '=', clientId)
        .where('manager_id', '=', ctx.userId)
        .execute();
      return loadOverview(trx, ctx, clientId);
    });
  }

  recordConsent(
    ctx: TenantContext,
    clientId: string,
    body: RecordCompanionConsentRequest,
    tzFallback?: string,
  ): Promise<ConsentResult> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      if (await isFuture(trx, ctx, body.consentedOn, tzFallback)) return 'future_date';
      const notice = await trx
        .selectFrom('companion_scripts')
        .select('id')
        .where('kind', '=', 'notice')
        .where('version', '=', body.noticeVersion)
        .executeTakeFirst();
      if (!notice) return 'unknown_notice';
      await trx
        .insertInto('companion_consents')
        .values({
          client_id: clientId,
          action: 'consent',
          notice_version: body.noticeVersion,
          effective_on: body.consentedOn,
          recorded_by: ctx.userId,
        })
        .execute();
      return loadOverview(trx, ctx, clientId);
    });
  }

  revokeConsent(
    ctx: TenantContext,
    clientId: string,
    body: RevokeCompanionConsentRequest,
    tzFallback?: string,
  ): Promise<ConsentResult> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      if (await isFuture(trx, ctx, body.revokedOn, tzFallback)) return 'future_date';
      const latest = await latestConsentRow(trx, clientId);
      if (latest?.action !== 'consent') return 'not_consented';
      await trx
        .insertInto('companion_consents')
        .values({
          client_id: clientId,
          action: 'revoke',
          notice_version: null,
          effective_on: body.revokedOn,
          recorded_by: ctx.userId,
        })
        .execute();
      return loadOverview(trx, ctx, clientId);
    });
  }

  /**
   * 绑定设备：序列号不存在、激活码不对、设备已被绑定，都返回 unavailable（不透露设备属于谁）。
   * 激活码在事务外校验（argon2 耗时），绑定函数里再锁行确认设备仍是库存。
   */
  async bind(
    ctx: TenantContext,
    clientId: string,
    body: BindCompanionDeviceRequest,
  ): Promise<BindResult> {
    const candidate = await withTenant(this.db, ctx, async (trx) => {
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found' as const;
      const { rows } = await sql<{ id: string; status: string; activation_code_hash: string }>`
        select id, status, activation_code_hash from companion_device_for_binding(${body.serialNo})
      `.execute(trx);
      return rows[0] ?? null;
    });
    if (candidate === 'not_found') return 'not_found';
    const codeOk = candidate
      ? await verifyActivationCode(candidate.activation_code_hash, body.activationCode)
      : await verifyAgainstDummyCode(body.activationCode);
    if (!candidate || !codeOk) return 'unavailable';

    return withTenant(this.db, ctx, async (trx) => {
      const { rows } = await sql<{ result: string }>`
        select bind_companion_device(${candidate.id}::uuid, ${clientId}::uuid) as result
      `.execute(trx);
      const result = rows[0]?.result;
      if (result !== 'ok') {
        return result === 'not_found' || result === 'already_bound' || result === 'no_consent'
          ? result
          : 'unavailable';
      }
      return loadOverview(trx, ctx, clientId);
    });
  }

  unbind(ctx: TenantContext, clientId: string): Promise<DeviceActionResult> {
    return this.deviceAction(ctx, clientId, sql`unbind_companion_device(${clientId}::uuid)`);
  }

  setPaused(ctx: TenantContext, clientId: string, paused: boolean): Promise<DeviceActionResult> {
    return this.deviceAction(
      ctx,
      clientId,
      sql`set_companion_device_paused(${clientId}::uuid, ${paused})`,
    );
  }

  private deviceAction(
    ctx: TenantContext,
    clientId: string,
    call: ReturnType<typeof sql>,
  ): Promise<DeviceActionResult> {
    return withTenant(this.db, ctx, async (trx) => {
      const { rows } = await sql<{ result: string }>`select ${call} as result`.execute(trx);
      const result = rows[0]?.result;
      if (result === 'ok') return loadOverview(trx, ctx, clientId);
      if (result === 'no_device' || result === 'invalid_state') return result;
      return 'not_found';
    });
  }
}

async function isFuture(
  trx: TenantTransaction,
  ctx: TenantContext,
  date: string,
  tzFallback?: string,
): Promise<boolean> {
  const tz = await managerTimeZone(trx, ctx, tzFallback);
  return date > localDate(new Date(), tz);
}

async function latestConsentRow(trx: TenantTransaction, clientId: string) {
  return trx
    .selectFrom('companion_consents')
    .select((eb) => [
      'action',
      'notice_version',
      'created_at',
      dateText(eb, 'effective_on').as('effective_on'),
    ])
    .where('client_id', '=', clientId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/** 当前同意：最近一次“同意”，以及它之后的撤回（如有） */
async function loadConsent(
  trx: TenantTransaction,
  clientId: string,
): Promise<CompanionConsent | null> {
  const rows = await trx
    .selectFrom('companion_consents')
    .select((eb) => [
      'id',
      'action',
      'notice_version',
      'created_at',
      dateText(eb, 'effective_on').as('effective_on'),
    ])
    .where('client_id', '=', clientId)
    .orderBy('id', 'desc')
    .limit(2)
    .execute();
  const [latest, previous] = rows;
  if (!latest) return null;
  const consent = latest.action === 'consent' ? latest : previous;
  if (!consent || consent.action !== 'consent' || consent.notice_version === null) return null;
  return {
    noticeVersion: consent.notice_version,
    consentedOn: consent.effective_on,
    recordedAt: consent.created_at.toISOString(),
    revokedOn: latest.action === 'revoke' ? latest.effective_on : null,
  };
}

async function loadOverview(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
): Promise<CompanionOverview> {
  const client = await trx
    .selectFrom('clients')
    .select(['companion_name_for_client', 'companion_voice_speed', 'companion_volume'])
    .where('id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .executeTakeFirstOrThrow();
  const deviceRow = await trx
    .selectFrom('companion_devices')
    .select(['serial_no', 'status', 'bound_at', 'activated_at', 'last_seen_at', 'firmware_version'])
    .where('client_id', '=', clientId)
    .where('manager_id', '=', ctx.userId)
    .executeTakeFirst();
  const notice = await trx
    .selectFrom('companion_scripts')
    .select((eb) => eb.fn.max('version').as('version'))
    .where('kind', '=', 'notice')
    .executeTakeFirst();

  let device: CompanionDevice | null = null;
  if (deviceRow?.bound_at) {
    const lastSeen = deviceRow.last_seen_at;
    device = {
      serialLast4: serialLast4(deviceRow.serial_no),
      status: deviceRow.status,
      boundAt: deviceRow.bound_at.toISOString(),
      activatedAt: iso(deviceRow.activated_at),
      lastSeenAt: iso(lastSeen),
      online: lastSeen !== null && Date.now() - lastSeen.getTime() <= COMPANION_ONLINE_WINDOW_MS,
      firmwareVersion: deviceRow.firmware_version,
    };
  }
  return {
    status: companionStatusOf(device),
    device,
    consent: await loadConsent(trx, clientId),
    settings: {
      nameForClient: client.companion_name_for_client,
      voiceSpeed: client.companion_voice_speed,
      volume: client.companion_volume,
    },
    currentNoticeVersion: notice?.version ?? null,
  };
}
