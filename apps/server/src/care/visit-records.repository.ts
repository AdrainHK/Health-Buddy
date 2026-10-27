import { Inject, Injectable } from '@nestjs/common';
import type { VisitRecord, VisitRecordStructured, VisitRecordSummary } from '@health-buddy/shared';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { clientVisible } from '../twin/twin.repository.js';
import { dateText } from './common.js';

/**
 * 随访记录（M5 规格 2.9、6.4）：只经确认函数写入（3b），确认后不能修改，只能追加补充说明。
 * 只有服务这位客户的健管师能看（Q28）。记录内容不进日志。
 */

/** 时间轴和列表里摘要的长度 */
const EXCERPT_CHARS = 50;

@Injectable()
export class VisitRecordsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 客户的随访记录，按随访日期倒序；客户不是自己的返回 undefined */
  list(ctx: TenantContext, clientId: string): Promise<VisitRecordSummary[] | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      if (!(await clientVisible(trx, clientId))) return undefined;
      const rows = await selectRecords(trx)
        .where('client_id', '=', clientId)
        .orderBy('visit_date', 'desc')
        .orderBy('approved_at', 'desc')
        .limit(200)
        .execute();
      return rows.map(toSummary);
    });
  }

  get(ctx: TenantContext, id: string): Promise<VisitRecord | undefined> {
    return withTenant(this.db, ctx, (trx) => getIn(trx, id));
  }

  /** 补充说明（只追加）；记录不是自己的返回 undefined */
  addAddendum(ctx: TenantContext, id: string, text: string): Promise<VisitRecord | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const record = await trx
        .selectFrom('visit_records')
        .select(['id', 'client_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!record) return undefined;
      await trx
        .insertInto('visit_record_addenda')
        .values({
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          client_id: record.client_id,
          record_id: record.id,
          text,
          created_by: ctx.userId,
        })
        .execute();
      return getIn(trx, id);
    });
  }
}

async function getIn(trx: TenantTransaction, id: string): Promise<VisitRecord | undefined> {
  const row = await selectRecords(trx).where('id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  const addenda = await trx
    .selectFrom('visit_record_addenda')
    .select(['id', 'text', 'created_at'])
    .where('record_id', '=', id)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return {
    ...toSummary(row),
    snapshot: row.snapshot as VisitRecordStructured,
    addenda: addenda.map((a) => ({
      id: a.id,
      text: a.text,
      createdAt: a.created_at.toISOString(),
    })),
  };
}

function selectRecords(trx: TenantTransaction) {
  return trx
    .selectFrom('visit_records')
    .select((eb) => [
      'id',
      'client_id',
      'visit_id',
      'method',
      'snapshot',
      'approved_at',
      dateText(eb, 'visit_date').as('visit_date_text'),
    ]);
}

function toSummary(r: {
  id: string;
  client_id: string;
  visit_id: string | null;
  method: VisitRecordSummary['method'];
  snapshot: unknown;
  approved_at: Date;
  visit_date_text: string;
}): VisitRecordSummary {
  const summary = (r.snapshot as Partial<VisitRecordStructured> | null)?.summary ?? '';
  return {
    id: r.id,
    clientId: r.client_id,
    visitId: r.visit_id,
    visitDate: r.visit_date_text,
    method: r.method,
    excerpt: Array.from(summary).slice(0, EXCERPT_CHARS).join(''),
    approvedAt: r.approved_at.toISOString(),
  };
}
