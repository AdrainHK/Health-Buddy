import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  buildClientDeliverable,
  countDisclaimers,
  DISCLAIMER,
  findBannedTerms,
  endsWithDisclaimer,
  type ApproveArtifactRequest,
  type ApproveRejection,
  type Artifact,
  type ArtifactDetailResponse,
  type ArtifactEvent,
  type CriticalFlag,
  type ExportFormat,
  PRODUCT_NAME,
  type UpdateArtifactRequest,
} from '@health-buddy/shared';
import { checkClientText, finalizeClientText, getSkill } from '@health-buddy/skills';
import { ApiException, conflict } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { selectArtifactSummary, toArtifactSummary } from '../tasks/tasks.repository.js';
import { renderPdf, renderPng } from './export-renderer.js';

type RejectReason = ApproveRejection['reasons'][number];

const readOnly = () => conflict({ reasons: ['read_only'] satisfies RejectReason[] });
const notLatestDraft = () => conflict({ reasons: ['not_latest_draft'] satisfies RejectReason[] });

/**
 * 产物仓储（M1 规格 3.6）。所有状态校验都在这里做，数据库触发器是第二道防线。
 * 产物只对健管师本人可见（行级安全），查不到就是不存在或不属于当前健管师。
 */
@Injectable()
export class ArtifactsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  detail(ctx: TenantContext, id: string): Promise<ArtifactDetailResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'none');
      return row && buildDetail(trx, row);
    });
  }

  /** 健管师修改草稿。通俗版重新拼接免责声明，删不掉也不会重复。 */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateArtifactRequest,
  ): Promise<ArtifactDetailResponse | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'lock');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (
        row.status !== 'draft' ||
        row.version !== input.version ||
        contentHash(row.content) !== input.contentHash ||
        !(await isLatest(trx, row))
      ) {
        throw notLatestDraft();
      }
      await trx
        .updateTable('artifacts')
        .set({
          content: JSON.stringify({
            professional: input.content.professional,
            clientFacing: finalizeClientText(input.content.clientFacing),
          }),
        })
        .where('id', '=', id)
        .execute();
      await recordEvent(trx, ctx, row, 'edited');
      const updated = await loadArtifact(trx, id, 'none');
      return updated && buildDetail(trx, updated);
    });
  }

  /**
   * 确认（规格 3.6）。全部检查在同一个事务里做，任何一项不通过都返回 409 和全部原因，
   * 前端据此标出问题位置。
   */
  approve(
    ctx: TenantContext,
    id: string,
    input: Required<ApproveArtifactRequest>,
  ): Promise<ArtifactDetailResponse | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'lock');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      const reasons: RejectReason[] = [];
      if (
        row.status !== 'draft' ||
        row.version !== input.version ||
        contentHash(row.content) !== input.contentHash ||
        !(await isLatest(trx, row))
      ) {
        reasons.push('not_latest_draft');
      }
      const text = row.content.clientFacing;
      const banned = findBannedTerms(text);
      if (banned.length) reasons.push('banned_terms');
      if (!endsWithDisclaimer(text)) reasons.push('missing_disclaimer');
      else if (countDisclaimers(text) > 1) reasons.push('duplicate_disclaimer');
      else if (!text.trimEnd().slice(0, -DISCLAIMER.length).trim()) {
        reasons.push('empty_client_text');
      }
      // 危急指标永远不进通俗版（规格 3.6）：数值出现在通俗版里就不能确认
      const { criticalValueMentions } = checkClientText(text, row.critical_flags);
      if (criticalValueMentions.length) reasons.push('critical_value_in_client_text');
      const hasCritical = row.critical_flags.length > 0;
      if (hasCritical && !input.acknowledgedCritical) reasons.push('critical_not_acknowledged');
      if (reasons.length) {
        throw conflict({
          reasons,
          ...(banned.length
            ? { bannedTerms: banned.map((b) => ({ term: b.term, index: b.index })) }
            : {}),
          ...(criticalValueMentions.length
            ? {
                criticalValueMentions: criticalValueMentions.map((m) => ({
                  metric: m.metric,
                  index: m.index,
                })),
              }
            : {}),
        });
      }
      await trx.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute();
      // 有危急指标时记下“已知悉”，便于追溯
      await recordEvent(trx, ctx, row, 'approved', hasCritical ? CRITICAL_ACKNOWLEDGED : null);
      const updated = await loadArtifact(trx, id, 'none');
      return updated && buildDetail(trx, updated);
    });
  }

  /** 基于已审核产物新建一个草稿版本（Q7）。只能基于这条产物链的最新一版。 */
  revise(ctx: TenantContext, id: string): Promise<ArtifactDetailResponse | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'lock');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (row.status !== 'approved' || !(await isLatest(trx, row))) throw conflict();
      const created = await trx
        .insertInto('artifacts')
        .values({
          task_id: row.task_id,
          client_id: row.client_id,
          operator_id: ctx.operatorId ?? '',
          org_id: ctx.orgId,
          manager_id: ctx.userId,
          skill_id: row.skill_id,
          kind: row.kind,
          lineage_id: row.lineage_id,
          version: row.version + 1,
          parent_id: row.id,
          status: 'draft',
          content: JSON.stringify(row.content),
          // 危急指标沿用原版本识别时的快照
          critical_flags: JSON.stringify(row.critical_flags),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const next = await loadArtifact(trx, created.id, 'none');
      if (!next) return undefined;
      await recordEvent(trx, ctx, next, 'created');
      return buildDetail(trx, next);
    });
  }

  /**
   * 复制已审核产物的通俗版，并记一条复制记录（不记内容）。
   * 只有已审核、任务未断开的产物可以；返回的只有通俗版，末尾带免责声明和产品名称。
   */
  copyClientText(ctx: TenantContext, id: string): Promise<string | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'share');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (row.status !== 'approved') throw conflict();
      // 已审核内容数据库层不能再改，这里再查一遍只是多一道保险
      const text = row.content.clientFacing;
      if (findBannedTerms(text).length || !endsWithDisclaimer(text)) throw conflict();
      await recordEvent(trx, ctx, row, 'copied');
      return buildClientDeliverable(text);
    });
  }

  /**
   * 导出已审核产物的通俗版（图片或 PDF），并记一条导出记录（谁、什么时候、什么格式，不记内容）。
   * 检查和复制相同；文件在同一个事务里生成，生成失败就不留记录。
   */
  exportClientText(
    ctx: TenantContext,
    id: string,
    format: ExportFormat,
  ): Promise<{ file: Buffer; filename: string } | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'share');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (row.status !== 'approved') throw conflict();
      const text = row.content.clientFacing;
      if (findBannedTerms(text).length || !endsWithDisclaimer(text)) throw conflict();
      const title = getSkill(row.skill_id)?.title ?? PRODUCT_NAME;
      const date = shanghaiDate(new Date());
      const doc = { title, date, body: buildClientDeliverable(text) };
      const file = format === 'pdf' ? await renderPdf(doc) : renderPng(doc);
      await recordEvent(trx, ctx, row, 'exported', null, format);
      // 文件名不带客户姓名（规格 3.6）
      return { file, filename: `${title}-${date}.${format}` };
    });
  }

  /**
   * 数据库层的保护（触发器、唯一约束）在并发时可能先于上面的检查触发，
   * 统一转成 409，不让它们变成 500。
   */
  private async write<T>(ctx: TenantContext, fn: (trx: TenantTransaction) => Promise<T>) {
    try {
      return await withTenant(this.db, ctx, fn);
    } catch (err) {
      if (err instanceof ApiException) throw err;
      if (['23514', '23505', '40P01', '40001'].includes(dbErrorCode(err))) throw conflict();
      throw err;
    }
  }
}

/** 确认时记在记录里的原因：健管师勾选了危急指标“已知悉” */
const CRITICAL_ACKNOWLEDGED = 'critical_acknowledged';

/** 内容指纹：专业版和通俗版的 SHA-256 前 32 位 */
export function contentHash(content: { professional: string; clientFacing: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([content.professional, content.clientFacing]))
    .digest('hex')
    .slice(0, 32);
}

interface ArtifactRow {
  id: string;
  task_id: string;
  client_id: string | null;
  skill_id: string;
  kind: string;
  lineage_id: string;
  version: number;
  parent_id: string | null;
  status: Artifact['status'];
  content: { professional: string; clientFacing: string };
  critical_flags: CriticalFlag[];
  created_at: Date;
  detached: boolean;
}

/**
 * 读产物和它所属任务的只读状态。
 * - lock：先锁任务（共享锁）再锁产物（排他锁），和客户转出时“先锁任务再作废草稿”的顺序一致，
 *   保证转出和这里的写入串行，不会漏作废刚生成的草稿。
 * - share：只给任务和产物加共享锁（复制时用）。
 */
async function loadArtifact(
  trx: TenantTransaction,
  id: string,
  lock: 'none' | 'share' | 'lock',
): Promise<ArtifactRow | undefined> {
  if (lock !== 'none') {
    const ref = await trx
      .selectFrom('artifacts')
      .select('task_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!ref) return undefined;
    await trx.selectFrom('tasks').select('id').where('id', '=', ref.task_id).forShare().execute();
  }
  let q = trx
    .selectFrom('artifacts')
    .innerJoin('tasks', 'tasks.id', 'artifacts.task_id')
    .select([
      'artifacts.id',
      'artifacts.task_id',
      'artifacts.client_id',
      'artifacts.skill_id',
      'artifacts.kind',
      'artifacts.lineage_id',
      'artifacts.version',
      'artifacts.parent_id',
      'artifacts.status',
      'artifacts.content',
      'artifacts.critical_flags',
      'artifacts.created_at',
      'tasks.detached_reason',
    ])
    .where('artifacts.id', '=', id);
  if (lock === 'lock') q = q.forUpdate('artifacts');
  if (lock === 'share') q = q.forShare('artifacts');
  const row = await q.executeTakeFirst();
  if (!row) return undefined;
  const { detached_reason, ...rest } = row;
  return {
    ...rest,
    critical_flags: row.critical_flags as CriticalFlag[],
    detached: detached_reason !== null,
  };
}

async function isLatest(trx: TenantTransaction, row: ArtifactRow): Promise<boolean> {
  const newer = await trx
    .selectFrom('artifacts')
    .select('id')
    .where('lineage_id', '=', row.lineage_id)
    .where('version', '>', row.version)
    .executeTakeFirst();
  return !newer;
}

async function recordEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  row: Pick<ArtifactRow, 'id'>,
  action: 'created' | 'edited' | 'approved' | 'copied' | 'exported',
  reason: string | null = null,
  format: ExportFormat | null = null,
): Promise<void> {
  await trx
    .insertInto('artifact_events')
    .values({
      artifact_id: row.id,
      operator_id: ctx.operatorId ?? '',
      org_id: ctx.orgId,
      manager_id: ctx.userId,
      actor_id: ctx.userId,
      action,
      reason,
      format,
    })
    .execute();
}

async function buildDetail(
  trx: TenantTransaction,
  row: ArtifactRow,
): Promise<ArtifactDetailResponse> {
  const versions = await selectArtifactSummary(trx)
    .where('lineage_id', '=', row.lineage_id)
    .orderBy('version')
    .execute();
  const events = await trx
    .selectFrom('artifact_events')
    .innerJoin('artifacts', 'artifacts.id', 'artifact_events.artifact_id')
    .select([
      'artifact_events.id',
      'artifact_events.artifact_id',
      'artifact_events.actor_id',
      'artifact_events.action',
      'artifact_events.reason',
      'artifact_events.format',
      'artifact_events.created_at',
    ])
    .where('artifacts.lineage_id', '=', row.lineage_id)
    .orderBy('artifact_events.created_at')
    .orderBy('artifact_events.id')
    .execute();
  return {
    artifact: {
      ...toArtifactSummary(row),
      clientId: row.client_id,
      parentId: row.parent_id,
      content: row.content,
      contentHash: contentHash(row.content),
      criticalFlags: row.critical_flags,
    },
    hints: { judgementHints: checkClientText(row.content.clientFacing).judgementHints },
    versions: versions.map(toArtifactSummary),
    events: events.map((e): ArtifactEvent => ({
      id: e.id,
      artifactId: e.artifact_id,
      actorId: e.actor_id,
      action: e.action,
      reason: e.reason,
      format: e.format,
      createdAt: e.created_at.toISOString(),
    })),
  };
}

/** 导出文件上的日期按北京时间 */
function shanghaiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
