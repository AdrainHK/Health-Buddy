import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  COMPANION_SCRIPT_KINDS,
  type CompanionScript,
  type CompanionScriptKind,
  type DeviceBatch,
  type ImportDeviceBatchRequest,
} from '@health-buddy/shared';
import { companionDeviceBatchStats, companionExistingSerials } from '../db/companion-functions.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';
import {
  DeviceSecretCipher,
  hashActivationCode,
  hashDeviceSecret,
  mapLimited,
} from './device-credentials.js';

/**
 * 平台端：出厂设备批次、固定话术和线下告知书模板（M6 规格 2.10、N2、Q22、N4）。
 * 平台看不到设备绑给了谁，只经统计函数看每批的绑定数。
 */

export type ImportBatchResult = DeviceBatch | { duplicates: string[] } | 'not_configured';

@Injectable()
export class CompanionAdminRepository {
  private readonly cipher: DeviceSecretCipher | null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cipher = config.companionDeviceKey
      ? new DeviceSecretCipher(config.companionDeviceKey)
      : null;
  }

  batches(ctx: TenantContext): Promise<DeviceBatch[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await companionDeviceBatchStats(trx);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        deviceCount: r.device_count,
        boundCount: r.bound_count,
        importedAt: r.imported_at.toISOString(),
      }));
    });
  }

  /** 导入一批库存设备。已存在的序列号整批拒绝，返回这些序列号（序列号不是客户数据） */
  async importBatch(
    ctx: TenantContext,
    body: ImportDeviceBatchRequest,
  ): Promise<ImportBatchResult> {
    const cipher = this.cipher;
    if (!cipher) return 'not_configured';
    const serials = body.devices.map((d) => d.serialNo);
    const existing = await withTenant(this.db, ctx, async (trx) => {
      return companionExistingSerials(trx, serials);
    });
    if (existing.length) return { duplicates: existing.sort() };

    const rows = await mapLimited(body.devices, 4, async (d) => ({
      serial_no: d.serialNo,
      secret_hash: hashDeviceSecret(d.deviceSecret),
      secret_encrypted: cipher.encrypt(d.deviceSecret, d.serialNo),
      activation_code_hash: await hashActivationCode(d.activationCode),
    }));
    return withTenant(this.db, ctx, async (trx) => {
      const batch = await trx
        .insertInto('companion_device_batches')
        .values({ name: body.name, device_count: rows.length, imported_by: ctx.userId })
        .returning(['id', 'name', 'device_count', 'imported_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('companion_devices')
        .values(rows.map((r) => ({ ...r, batch_id: batch.id })))
        .execute();
      return {
        id: batch.id,
        name: batch.name,
        deviceCount: batch.device_count,
        boundCount: 0,
        importedAt: batch.imported_at.toISOString(),
      };
    });
  }

  /** 每种话术的当前（最新）版本 */
  currentScripts(ctx: TenantContext): Promise<CompanionScript[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('companion_scripts')
        .distinctOn('kind')
        .select(['kind', 'version', 'text', 'created_at'])
        .orderBy('kind')
        .orderBy('version', 'desc')
        .execute();
      const order = new Map(COMPANION_SCRIPT_KINDS.map((k, i) => [k as string, i]));
      return rows.map(toScript).sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0));
    });
  }

  /** 当前的告知书模板（健管师打印用）；还没有时 undefined */
  currentNotice(ctx: TenantContext): Promise<CompanionScript | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('companion_scripts')
        .select(['kind', 'version', 'text', 'created_at'])
        .where('kind', '=', 'notice')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? toScript(row) : undefined;
    });
  }

  history(ctx: TenantContext, kind: CompanionScriptKind): Promise<CompanionScript[]> {
    return withTenant(this.db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('companion_scripts')
        .select(['kind', 'version', 'text', 'created_at'])
        .where('kind', '=', kind)
        .orderBy('version', 'desc')
        .execute();
      return rows.map(toScript);
    });
  }

  /** 保存即新版本（版本号由触发器加一）；新会话生效 */
  saveScript(
    ctx: TenantContext,
    kind: CompanionScriptKind,
    text: string,
  ): Promise<CompanionScript> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await trx
        .insertInto('companion_scripts')
        .values({ kind, text, created_by: ctx.userId })
        .returning(['kind', 'version', 'text', 'created_at'])
        .executeTakeFirstOrThrow();
      return toScript(row);
    });
  }
}

function toScript(row: {
  kind: string;
  version: number;
  text: string;
  created_at: Date;
}): CompanionScript {
  return {
    kind: row.kind as CompanionScriptKind,
    version: row.version,
    text: row.text,
    updatedAt: row.created_at.toISOString(),
  };
}
