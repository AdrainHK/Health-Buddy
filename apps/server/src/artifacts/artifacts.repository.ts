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
  type PlanOptions,
  type RiskTierSuggestion,
  type UpdateArtifactRequest,
} from '@health-buddy/shared';
import { checkClientText, finalizeClientText, getSkill } from '@health-buddy/skills';
import { ApiException, conflict, notFound } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext, type TenantTransaction } from '../db/database.js';
import { selectArtifactSummary, toArtifactSummary } from '../tasks/tasks.repository.js';
import { localDate, isValidTimeZone } from '../twin/time-zone.js';
import { approveCarePlan, approveVisitRecord, approveVisitSchedule } from '../db/plan-functions.js';
import { renderPdf, renderPng } from './export-renderer.js';
import {
  carePlanApproveReasons,
  isM5WritingKind,
  professionalOnlyKind,
  recordApproveReasons,
  scheduleApproveReasons,
  validateEditedStructured,
} from './m5-artifacts.js';

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
        contentHash(row.content, row.structured) !== input.contentHash ||
        !(await isLatest(trx, row))
      ) {
        throw notLatestDraft();
      }
      // M5：方案和随访计划的结构化内容（替换库条目、改参数、改日程），不合格 400
      const structured =
        input.structured === undefined
          ? undefined
          : await validateEditedStructured(trx, ctx, row.kind, input.structured);
      await trx
        .updateTable('artifacts')
        .set({
          ...(structured === undefined ? {} : { structured: JSON.stringify(structured) }),
          content: JSON.stringify({
            professional: input.content.professional,
            // 没有通俗版的技能（/面谈提纲）通俗版始终为空，不拼免责声明（规格 2.8）
            clientFacing: isClientFacing(row) ? finalizeClientText(input.content.clientFacing) : '',
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
      // 采用建议分层要写客户的分层历史：先锁客户行，再锁任务和产物。
      // 和客户转出、删除（先锁客户，再锁任务）的加锁顺序一致，避免死锁
      const kind = await kindOf(trx, id);
      const m5 = kind !== undefined && isM5WritingKind(kind);
      // M5 的确认函数会以 no key update 锁客户行，这里先用同样的锁，保持“客户 → 任务 → 产物”的顺序
      const lockedClientId =
        input.adoptRiskTier || m5 ? await lockClientOf(trx, ctx, id, m5) : null;
      const row = await loadArtifact(trx, id, 'lock');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      const reasons: RejectReason[] = [];
      if (
        row.status !== 'draft' ||
        row.version !== input.version ||
        contentHash(row.content, row.structured) !== input.contentHash ||
        !(await isLatest(trx, row))
      ) {
        reasons.push('not_latest_draft');
      }
      // M5 按产物类型的检查（规格 2.3、2.7、2.9）
      if (row.kind === 'care_plan') {
        reasons.push(
          ...(await carePlanApproveReasons(trx, row, input.acknowledgedAllergens ?? false)),
        );
      } else if (row.kind === 'visit_schedule') {
        reasons.push(...(await scheduleApproveReasons(trx, ctx, row.structured)));
      } else if (row.kind === 'visit_record') {
        reasons.push(...(await recordApproveReasons(trx, ctx, row.structured)));
      }
      if (m5 && lockedClientId === null) throw readOnly();
      // 没有通俗版的技能（/面谈提纲）跳过通俗版相关检查（规格 4.1 框架扩展）
      const clientFacing = isClientFacing(row);
      const text = row.content.clientFacing;
      const banned = clientFacing ? findBannedTerms(text) : [];
      if (banned.length) reasons.push('banned_terms');
      if (clientFacing) {
        if (!endsWithDisclaimer(text)) reasons.push('missing_disclaimer');
        else if (countDisclaimers(text) > 1) reasons.push('duplicate_disclaimer');
        else if (!text.trimEnd().slice(0, -DISCLAIMER.length).trim()) {
          reasons.push('empty_client_text');
        }
      }
      // 危急指标永远不进通俗版（规格 3.6）：数值出现在通俗版里就不能确认；
      // 分层只给健管师看（Q20）：分层字样出现在通俗版里也不能确认
      const { criticalValueMentions, riskTierMentions } = clientFacing
        ? checkClientText(text, row.critical_flags)
        : { criticalValueMentions: [], riskTierMentions: [] };
      if (criticalValueMentions.length) reasons.push('critical_value_in_client_text');
      if (riskTierMentions.length) reasons.push('risk_tier_in_client_text');
      const hasCritical = row.critical_flags.length > 0;
      if (hasCritical && !input.acknowledgedCritical) reasons.push('critical_not_acknowledged');
      // 采用建议分层（规格 2.7）：产物必须有建议分层
      if (input.adoptRiskTier && !row.risk_tier_suggestion) reasons.push('no_risk_tier_suggestion');
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
          ...(riskTierMentions.length ? { riskTierMentions } : {}),
        });
      }
      if (row.kind === 'care_plan') {
        // 方案生效：写入 care_plans，旧方案被替代，排一次方案复评（数据库函数在同一事务里完成）
        await approveCarePlan(trx, id);
      } else if (row.kind === 'visit_schedule') {
        await approveVisitSchedule(trx, id);
      } else if (row.kind === 'visit_record') {
        // 勾选的跟进项有一个不是这位客户未处理的，函数报 no_data_found，整个事务回滚 → 404
        await approveVisitRecord(trx, id, input.resolveFollowUpItemIds ?? []);
      } else {
        await trx
          .updateTable('artifacts')
          .set({ status: 'approved' })
          .where('id', '=', id)
          .execute();
      }
      if (input.adoptRiskTier && row.risk_tier_suggestion) {
        await adoptRiskTier(trx, ctx, row, row.risk_tier_suggestion, lockedClientId);
      }
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
          // 危急指标、依据的报告、建议分层和专家调用沿用原版本的快照
          critical_flags: JSON.stringify(row.critical_flags),
          source_report_id: row.source_report_id,
          consultation_id: row.consultation_id,
          emergency_signal: row.emergency_signal,
          crisis_signal: row.crisis_signal,
          risk_tier_suggestion: row.risk_tier_suggestion
            ? JSON.stringify(row.risk_tier_suggestion)
            : null,
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
      // 没有通俗版的产物（/面谈提纲）不能复制给客户（规格 2.8、Q21）
      if (!isClientFacing(row)) throw notClientFacing();
      if (row.status !== 'approved') throw conflict();
      const text = deliverableText(row);
      await recordEvent(trx, ctx, row, 'copied');
      return buildClientDeliverable(text);
    });
  }

  /**
   * 导出已审核产物的通俗版（图片或 PDF），并记一条导出记录（谁、什么时候、什么格式，不记内容）。
   * 检查和复制相同，另外标题也要合规；文件在同一个事务里生成，生成失败就不留记录。
   */
  exportClientText(
    ctx: TenantContext,
    id: string,
    format: ExportFormat,
    tz?: string,
  ): Promise<{ file: Buffer; filename: string } | undefined> {
    return this.write(ctx, async (trx) => {
      const row = await loadArtifact(trx, id, 'share');
      if (!row) return undefined;
      if (row.detached) throw readOnly();
      if (!isClientFacing(row)) throw notClientFacing();
      if (row.status !== 'approved') throw conflict();
      const text = deliverableText(row);
      // 标题会印在文件上、写进文件名，找不到技能或标题不合规就不导出
      // 技能还没注册（M5 方案在第 5 步接入技能）时用固定的概括文字
      const title = getSkill(row.skill_id)?.title ?? EXPORT_SUMMARIES[row.skill_id];
      if (!title || findBannedTerms(title).length) throw conflict();
      const date = shanghaiDate(new Date());
      const doc = { title, date, body: buildClientDeliverable(text) };
      const file = format === 'pdf' ? await renderPdf(doc) : renderPng(doc);
      await recordEvent(trx, ctx, row, 'exported', null, format);
      return { file, filename: exportFileName(row, format, tz) };
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
      // 确认函数：跟进项、产物不属于当前健管师（no_data_found）→ 404
      if (dbErrorCode(err) === 'P0002') throw notFound();
      if (['23514', '23505', '40P01', '40001'].includes(dbErrorCode(err))) throw conflict();
      throw err;
    }
  }
}

/** 确认时记在记录里的原因：健管师勾选了危急指标“已知悉” */
const CRITICAL_ACKNOWLEDGED = 'critical_acknowledged';

/** 内容指纹：专业版和通俗版的 SHA-256 前 32 位 */
export function contentHash(
  content: { professional: string; clientFacing: string },
  structured: unknown = null,
): string {
  // 有结构化内容（M5）时一起算，别人改了日程或库条目也能发现；没有时和 M1 的算法一样
  const parts: unknown[] = [content.professional, content.clientFacing];
  if (structured !== null && structured !== undefined) parts.push(structured);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
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
  source_report_id: string | null;
  risk_tier_suggestion: RiskTierSuggestion | null;
  consultation_id: string | null;
  emergency_signal: boolean;
  crisis_signal: boolean;
  structured: unknown;
  plan_options: unknown;
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
      'artifacts.source_report_id',
      'artifacts.risk_tier_suggestion',
      'artifacts.consultation_id',
      'artifacts.emergency_signal',
      'artifacts.crisis_signal',
      'artifacts.structured',
      'artifacts.plan_options',
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
  // 当前这一版在版本列表里，标题用的报告日期和文件名从那里取
  const self = versions.find((v) => v.id === row.id);
  return {
    artifact: {
      ...toArtifactSummary({
        ...row,
        source_report_date: self?.source_report_date ?? null,
        source_file_name: self?.source_file_name ?? null,
      }),
      clientId: row.client_id,
      parentId: row.parent_id,
      content: row.content,
      contentHash: contentHash(row.content, row.structured),
      criticalFlags: row.critical_flags,
      sourceReportId: row.source_report_id,
      riskTierSuggestion: row.risk_tier_suggestion,
      consultationId: row.consultation_id,
      emergencySignal: row.emergency_signal,
      crisisSignal: row.crisis_signal,
      clientFacing: isClientFacing(row),
      structured: row.structured ?? null,
      planOptions: (row.plan_options as PlanOptions | null) ?? null,
    },
    sourceReport: await sourceReport(trx, row),
    hints: clientTextHints(row),
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

/**
 * 详情里的通俗版提示。危急指标只给编码和位置，不给数值（数值在 criticalFlags 里，
 * 只给健管师看）。打开草稿就能标出，不必等确认被拒绝。
 */
function clientTextHints(row: ArtifactRow): ArtifactDetailResponse['hints'] {
  const check = checkClientText(row.content.clientFacing, row.critical_flags);
  return {
    judgementHints: check.judgementHints,
    criticalValueMentions: check.criticalValueMentions.map((m) => ({
      metric: m.metric,
      index: m.index,
    })),
    riskTierMentions: check.riskTierMentions,
  };
}

/**
 * 发给客户前再查一遍通俗版：已审核内容数据库层不能再改，这里是多一道保险。
 * 和确认时的检查一致：无禁用词、免责声明恰好一次且在末尾、不含危急指标数值。
 */
function deliverableText(row: ArtifactRow): string {
  const text = row.content.clientFacing;
  if (
    findBannedTerms(text).length ||
    !endsWithDisclaimer(text) ||
    countDisclaimers(text) !== 1 ||
    checkClientText(text, row.critical_flags).criticalValueMentions.length ||
    checkClientText(text, row.critical_flags).riskTierMentions.length
  ) {
    throw conflict();
  }
  return text;
}

/**
 * 导出文件名（产品负责人反馈的命名规则：称呼 + 内容概括 + 日期 + 第几版），如
 * “体检报告解读 2026-10-19 第1版.pdf”。导出的是给客户的通俗版，文件名仍然不带客户姓名
 * （M1 规格 3.6、M2 规格 2.10）。日期是这一版的生成日期，按健管师时区（没有时按北京时间）。
 * 只用固定的概括文字、日期和数字，再去掉文件系统不允许的字符。
 */
export function exportFileName(
  row: Pick<ArtifactRow, 'skill_id' | 'version' | 'created_at'>,
  format: ExportFormat,
  tz?: string,
): string {
  const summary = EXPORT_SUMMARIES[row.skill_id] ?? getSkill(row.skill_id)?.title ?? '';
  const date =
    tz && isValidTimeZone(tz) ? localDate(row.created_at, tz) : shanghaiDate(row.created_at);
  const name = [summary, date, `第${row.version}版`].filter(Boolean).join(' ');
  const safe = Array.from(name)
    .filter((c) => c >= ' ' && !UNSAFE_FILE_CHARS.includes(c))
    .join('')
    .trim();
  return `${safe}.${format}`;
}

const UNSAFE_FILE_CHARS = '\\/:*?"<>|';

/** 文件名里的内容概括，和工作台产物标题一致（results.artifacts.title.summary）；没列的用技能标题 */
export const EXPORT_SUMMARIES: Record<string, string> = {
  'client-recent-summary': '近况小结',
  'report-interpretation': '体检报告解读',
  // M5 规格 2.3：“健康方案 日期 第几版”，不含客户姓名
  'care-plan': '健康方案',
};

/** 导出文件上的日期按北京时间 */
function shanghaiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const notClientFacing = () => conflict({ reasons: ['not_client_facing'] });

/** 技能有没有通俗版。找不到技能时按有通俗版处理，检查只会更严 */
function isClientFacing(row: Pick<ArtifactRow, 'skill_id' | 'kind'>): boolean {
  // M5 的随访计划、话术、记录只有专业版（规格 2.7、2.8、2.9），不论技能是否已经注册
  if (professionalOnlyKind(row.kind)) return false;
  return getSkill(row.skill_id)?.clientFacing ?? true;
}

/**
 * 依据的报告：日期，以及生成之后有没有指标被更正过（更正会插入新的指标行，规格 2.4）。
 * 以当前账号查，看不到的报告（客户已转出）按没有处理。
 */
async function sourceReport(
  trx: TenantTransaction,
  row: Pick<ArtifactRow, 'source_report_id' | 'created_at'>,
): Promise<ArtifactDetailResponse['sourceReport']> {
  if (!row.source_report_id) return null;
  const report = await trx
    .selectFrom('health_reports')
    .select((eb) => [
      'id',
      eb.fn<string>('to_char', [eb.ref('report_date'), eb.val('YYYY-MM-DD')]).as('date'),
    ])
    .where('id', '=', row.source_report_id)
    .executeTakeFirst();
  if (!report) return null;
  const corrected = await trx
    .selectFrom('report_indicators')
    .select('id')
    .where('report_id', '=', report.id)
    .where('created_at', '>', row.created_at)
    .limit(1)
    .executeTakeFirst();
  return { id: report.id, reportDate: report.date, correctedSince: Boolean(corrected) };
}

/**
 * 采用建议分层前先锁住产物所属的客户行（共享锁），返回客户 id。
 * 先不加锁地读出产物的客户，再按“客户 → 任务 → 产物”的顺序加锁；
 * 客户已不归当前健管师（转出）时返回 null，之后按只读拒绝。
 */
async function lockClientOf(
  trx: TenantTransaction,
  ctx: TenantContext,
  artifactId: string,
  exclusive = false,
): Promise<string | null> {
  const ref = await trx
    .selectFrom('artifacts')
    .select('client_id')
    .where('id', '=', artifactId)
    .executeTakeFirst();
  if (!ref?.client_id) return null;
  let q = trx
    .selectFrom('clients')
    .select('id')
    .where('id', '=', ref.client_id)
    .where('manager_id', '=', ctx.userId);
  q = exclusive ? q.forNoKeyUpdate() : q.forShare();
  const client = await q.executeTakeFirst();
  return client?.id ?? null;
}

/** 产物类型（不加锁），决定确认时先锁什么 */
async function kindOf(trx: TenantTransaction, id: string): Promise<string | undefined> {
  const row = await trx
    .selectFrom('artifacts')
    .select('kind')
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.kind;
}

/**
 * 确认时采用建议分层（规格 2.7）：和确认在同一个事务里写入分层历史，来源记为这份产物。
 * 先锁住客户行，和并发的转出串行；客户已不归当前健管师时拒绝（整个确认回滚）。
 * 租户列由触发器取自客户行，行级安全和触发器再校验一遍归属和来源产物。
 */
async function adoptRiskTier(
  trx: TenantTransaction,
  ctx: TenantContext,
  row: Pick<ArtifactRow, 'id' | 'client_id'>,
  suggestion: RiskTierSuggestion,
  lockedClientId: string | null,
): Promise<void> {
  // 客户行已在确认开始时锁住；锁住之后产物仍属于这位客户才写入
  if (!row.client_id || row.client_id !== lockedClientId) throw readOnly();
  await trx
    .insertInto('client_risk_tiers')
    .values({
      operator_id: ctx.operatorId ?? '',
      org_id: ctx.orgId,
      manager_id: ctx.userId,
      client_id: row.client_id,
      tier: suggestion.tier,
      reason: suggestion.reason,
      source: 'artifact',
      source_artifact_id: row.id,
      set_by: ctx.userId,
    })
    .execute();
}
