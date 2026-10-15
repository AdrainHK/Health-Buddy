import { Inject, Injectable } from '@nestjs/common';
import {
  findBannedTerms,
  endsWithDisclaimer,
  type ApproveArtifactRequest,
  type ApproveRejection,
  type Artifact,
  type ArtifactDetailResponse,
  type ArtifactEvent,
  type CriticalFlag,
  type UpdateArtifactRequest,
} from '@health-buddy/shared';
import { finalizeClientText } from '@health-buddy/skills';
import { conflict } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { selectArtifactSummary, toArtifactSummary } from '../tasks/tasks.repository.js';

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
      const row = await lockArtifact(trx, id, false);
      return row && buildDetail(trx, row);
    });
  }

  /** 健管师修改草稿。通俗版重新拼接免责声明，删不掉也不会重复。 */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateArtifactRequest,
  ): Promise<ArtifactDetailResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await lockArtifact(trx, id, true);
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (row.status !== 'draft' || row.version !== input.version) throw notLatestDraft();
      if (!(await isLatest(trx, row))) throw notLatestDraft();
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
      const updated = await lockArtifact(trx, id, false);
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
    return withTenant(this.db, ctx, async (trx) => {
      const row = await lockArtifact(trx, id, true);
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      const reasons: RejectReason[] = [];
      if (row.status !== 'draft' || row.version !== input.version || !(await isLatest(trx, row))) {
        reasons.push('not_latest_draft');
      }
      const banned = findBannedTerms(row.content.clientFacing);
      if (banned.length) reasons.push('banned_terms');
      if (!endsWithDisclaimer(row.content.clientFacing)) reasons.push('missing_disclaimer');
      if (row.critical_flags.length > 0 && !input.acknowledgedCritical) {
        reasons.push('critical_not_acknowledged');
      }
      if (reasons.length) {
        throw conflict({
          reasons,
          ...(banned.length
            ? { bannedTerms: banned.map((b) => ({ term: b.term, index: b.index })) }
            : {}),
        });
      }
      await trx.updateTable('artifacts').set({ status: 'approved' }).where('id', '=', id).execute();
      await recordEvent(trx, ctx, row, 'approved');
      const updated = await lockArtifact(trx, id, false);
      return updated && buildDetail(trx, updated);
    });
  }

  /** 基于已审核产物新建一个草稿版本（Q7）。只能基于这条产物链的最新一版。 */
  revise(ctx: TenantContext, id: string): Promise<ArtifactDetailResponse | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await lockArtifact(trx, id, true);
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
      const next = await lockArtifact(trx, created.id, false);
      if (!next) return undefined;
      await recordEvent(trx, ctx, next, 'created');
      return buildDetail(trx, next);
    });
  }

  /**
   * 取已审核产物的通俗版用于复制，并记一条复制记录（不记内容）。
   * 只有已审核、任务未断开的产物可以；返回的内容只有通俗版。
   */
  clientText(ctx: TenantContext, id: string): Promise<string | undefined> {
    return withTenant(this.db, ctx, async (trx) => {
      const row = await lockArtifact(trx, id, false);
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (row.status !== 'approved') throw conflict();
      await recordEvent(trx, ctx, row, 'copied');
      return row.content.clientFacing;
    });
  }
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

async function lockArtifact(
  trx: TenantTransaction,
  id: string,
  forUpdate: boolean,
): Promise<ArtifactRow | undefined> {
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
  if (forUpdate) q = q.forUpdate('artifacts');
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
  action: 'created' | 'edited' | 'approved' | 'copied',
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
      reason: null,
      format: null,
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
      criticalFlags: row.critical_flags,
    },
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
