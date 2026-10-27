import { Inject, Injectable } from '@nestjs/common';
import {
  VISIT_MATERIALS_DAILY_MAX,
  type CreateVisitMaterialRequest,
  type VisitMaterial,
  type VisitMaterialListResponse,
} from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { visitMaterialsPurgeDue } from '../db/plan-functions.js';
import { clientVisible, ownClient } from '../twin/twin.repository.js';
import type { MaterialCipher } from './material-cipher.js';

/**
 * 随访素材（M5 规格 2.9、Q21、Q23、Q24）：只给上传的健管师看（行级安全），原文加密存储，
 * 30 天后由清理任务删除。原文不进日志、错误信息和埋点；列表和响应都不含原文。
 */

export type CreateMaterialResult =
  VisitMaterial | 'not_found' | 'visit_not_found' | 'consent_required' | 'daily_limit';

@Injectable()
export class VisitMaterialsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 上传素材。第一次为这位客户上传时必须勾选“已告知客户”（记下勾选人和时间，以后不再询问）；
   * 关联的随访必须是这位客户的；每位健管师每天最多 100 份（Q31）。
   */
  create(
    ctx: TenantContext,
    clientId: string,
    input: CreateVisitMaterialRequest,
    cipher: MaterialCipher,
  ): Promise<CreateMaterialResult> {
    return withTenant(this.db, ctx, async (trx) => {
      // 锁住客户行（共享锁），和并发的转出串行
      if (!(await ownClient(trx, ctx, clientId))) return 'not_found';
      if (input.visitId) {
        const visit = await trx
          .selectFrom('visits')
          .select('id')
          .where('id', '=', input.visitId)
          .where('client_id', '=', clientId)
          .executeTakeFirst();
        if (!visit) return 'visit_not_found';
      }
      const recent = await trx
        .selectFrom('visit_materials')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('uploaded_by', '=', ctx.userId)
        .where('created_at', '>', new Date(Date.now() - 86_400_000))
        .executeTakeFirstOrThrow();
      if (Number(recent.n) >= VISIT_MATERIALS_DAILY_MAX) return 'daily_limit';
      if (!(await hasConsent(trx, ctx, clientId))) {
        if (!input.consentConfirmed) return 'consent_required';
        await trx
          .insertInto('client_record_consents')
          .values({
            operator_id: ctx.operatorId ?? '',
            org_id: ctx.orgId,
            manager_id: ctx.userId,
            client_id: clientId,
            kind: 'visit_material',
            confirmed_by: ctx.userId,
          })
          .execute();
      }
      const text = input.text.trim();
      const row = await trx
        .insertInto('visit_materials')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: clientId,
          visit_id: input.visitId ?? null,
          kind: input.source ?? 'paste',
          text_encrypted: cipher.encrypt(text, clientId),
          char_count: Array.from(text).length,
          uploaded_by: ctx.userId,
        })
        .returning(MATERIAL_COLUMNS)
        .executeTakeFirstOrThrow();
      return toMaterial(row);
    });
  }

  /** 列出本人为这位客户上传的素材（不含原文）；客户不是自己的返回 undefined */
  list(ctx: TenantContext, clientId: string): Promise<VisitMaterialListResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const rows = await trx
        .selectFrom('visit_materials')
        .select(MATERIAL_COLUMNS)
        .where('client_id', '=', clientId)
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      return {
        materials: rows.map(toMaterial),
        consentRecorded: await hasConsent(trx, ctx, clientId),
      };
    });
  }

  /** 删除素材（只能删本人上传的，行级安全）；找不到返回 false */
  async remove(ctx: TenantContext, id: string): Promise<boolean> {
    return withTenant(this.db, ctx, async (trx) => {
      const res = await trx.deleteFrom('visit_materials').where('id', '=', id).executeTakeFirst();
      return Number(res.numDeletedRows) === 1;
    });
  }

  /** 清理到期的素材原文（后台任务，没有租户上下文）。只返回数量 */
  purgeDue(limit = 500): Promise<number> {
    return visitMaterialsPurgeDue(this.db, limit);
  }
}

const MATERIAL_COLUMNS = [
  'id',
  'client_id',
  'visit_id',
  'kind',
  'char_count',
  'consumed_artifact_id',
  'purge_after',
  'purged_at',
  'created_at',
] as const;

async function hasConsent(
  trx: TenantTransaction,
  ctx: TenantContext,
  clientId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('client_record_consents')
    .select('id')
    .where('client_id', '=', clientId)
    .where('kind', '=', 'visit_material')
    .where('confirmed_by', '=', ctx.userId)
    .executeTakeFirst();
  return Boolean(row);
}

function toMaterial(r: {
  id: string;
  client_id: string;
  visit_id: string | null;
  kind: 'paste' | 'txt';
  char_count: number;
  consumed_artifact_id: string | null;
  purge_after: Date;
  purged_at: Date | null;
  created_at: Date;
}): VisitMaterial {
  return {
    id: r.id,
    clientId: r.client_id,
    visitId: r.visit_id,
    kind: r.kind,
    charCount: r.char_count,
    consumedArtifactId: r.consumed_artifact_id,
    purgeAfter: r.purge_after.toISOString(),
    purged: r.purged_at !== null,
    createdAt: r.created_at.toISOString(),
  };
}
