import { Inject, Injectable } from '@nestjs/common';
import {
  COMPANION_DEFAULT_VOICE_SPEED,
  type CompanionScriptKind,
  type CompanionVoiceSpeed,
} from '@health-buddy/shared';
import { deviceSettings, markDeviceSeen } from '../../db/companion-device-auth.js';
import { DB } from '../../db/db.provider.js';
import { withDevice, type Db } from '../../db/database.js';

export interface DeviceState {
  status: 'stock' | 'bound' | 'active' | 'paused' | 'revoked';
  clientId: string | null;
  /** 这次绑定的时间：解绑后再绑回同一位客户时会变，会话据此断开 */
  boundAt: number | null;
  voiceSpeed: CompanionVoiceSpeed;
}

export interface Script {
  kind: CompanionScriptKind;
  version: number;
  text: string;
}

/**
 * 语音通道里设备会话的数据读写（M6 规格 3.3、6.2）。都在 withDevice 事务里：数据库按设备行查出
 * 当前绑定的客户（app_client_id），不信任调用方；设备只能读自己这一行和平台固定话术。
 */
@Injectable()
export class DeviceSessionRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 设备当前状态和客户的语速设置；设备行看不到时 undefined */
  state(deviceId: string): Promise<DeviceState | undefined> {
    return withDevice(this.db, { deviceId }, async (trx) => {
      const row = await trx
        .selectFrom('companion_devices')
        .select(['status', 'client_id', 'bound_at'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!row) return undefined;
      const settings = await deviceSettings(trx);
      return {
        status: row.status,
        clientId: row.client_id,
        boundAt: row.bound_at?.getTime() ?? null,
        voiceSpeed: settings?.voice_speed ?? COMPANION_DEFAULT_VOICE_SPEED,
      };
    });
  }

  /** 某种固定话术的当前版本 */
  script(deviceId: string, kind: CompanionScriptKind): Promise<Script | undefined> {
    return withDevice(this.db, { deviceId }, async (trx) => {
      const row = await trx
        .selectFrom('companion_scripts')
        .select(['version', 'text'])
        .where('kind', '=', kind)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? { kind, version: row.version, text: row.text } : undefined;
    });
  }

  /** 全部念出来的固定话术的当前版本（不含告知书模板），预合成用 */
  scripts(deviceId: string): Promise<Script[]> {
    return withDevice(this.db, { deviceId }, async (trx) => {
      const rows = await trx
        .selectFrom('companion_scripts')
        .distinctOn('kind')
        .select(['kind', 'version', 'text'])
        .where('kind', '!=', 'notice')
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

  seen(deviceId: string): Promise<void> {
    return markDeviceSeen(this.db, deviceId);
  }
}
