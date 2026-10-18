import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  EXPERT_EVAL_CASES,
  EXPERT_EVAL_TARGET,
  EXPERTS,
  expertName,
  getExpert,
  sourcesPending,
  statusAllowed,
} from '@health-buddy/experts';
import {
  EXPERT_ID_PATTERN,
  EXPERT_STATS_DEFAULT_DAYS,
  EXPERT_STATS_MAX_DAYS,
  expertStatsQuerySchema,
  type AdminExpertListResponse,
  type ExpertAvailabilityEventListResponse,
  type ExpertStatsResponse,
  type ExpertUsageTotal,
} from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden, notFound } from '../common/api-error.js';
import { requireExpertViewer } from '../common/manager-only.js';
import type { ExpertUsageStatsRow } from '../db/expert-functions.js';
import { ConsultationService } from './consultation.service.js';
import { ExpertsRepository } from './experts.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 统计的日期范围（UTC 自然日，含首尾）。不传时默认最近 30 天；
 * 只传 from 时截至今天，只传 to 时往前 30 天。倒置或超过 366 天按请求不对处理。
 */
function parseRange(query: unknown): { from: string; to: string; operatorId: string | null } {
  const parsed = expertStatsQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw badRequest();
  const to = parsed.data.to ?? isoDay(new Date());
  const from =
    parsed.data.from ?? isoDay(new Date(Date.parse(to) - (EXPERT_STATS_DEFAULT_DAYS - 1) * DAY_MS));
  // 2026-02-30 这类格式对、日期不存在的值也按请求不对处理，不交给数据库报错
  for (const d of [from, to]) {
    const t = Date.parse(d);
    if (Number.isNaN(t) || isoDay(new Date(t)) !== d) throw badRequest();
  }
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span >= EXPERT_STATS_MAX_DAYS) throw badRequest();
  return { from, to, operatorId: parsed.data.operatorId ?? null };
}

function rate(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

/** 费用估算保留到 6 位小数（和 llm_usage.cost_usd 一致），避免浮点累加的尾数 */
function roundCost(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

type Counts = Pick<
  ExpertUsageStatsRow,
  | 'calls'
  | 'succeeded'
  | 'timedOut'
  | 'inputTokens'
  | 'outputTokens'
  | 'costUsd'
  | 'useful'
  | 'notUseful'
>;

function withRates(c: Counts) {
  return {
    calls: c.calls,
    succeeded: c.succeeded,
    timedOut: c.timedOut,
    successRate: rate(c.succeeded, c.calls),
    timeoutRate: rate(c.timedOut, c.calls),
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costUsd: roundCost(c.costUsd),
    useful: c.useful,
    notUseful: c.notUseful,
  };
}

/** 按专家合计整个日期范围 */
function totalsByExpert(rows: readonly ExpertUsageStatsRow[]): Map<string, Counts> {
  const totals = new Map<string, Counts>();
  for (const r of rows) {
    const t = totals.get(r.expertId) ?? {
      calls: 0,
      succeeded: 0,
      timedOut: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      useful: 0,
      notUseful: 0,
    };
    t.calls += r.calls;
    t.succeeded += r.succeeded;
    t.timedOut += r.timedOut;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.costUsd += r.costUsd;
    t.useful += r.useful;
    t.notUseful += r.notUseful;
    totals.set(r.expertId, t);
  }
  return totals;
}

/** 平台总后台的专家管理只给平台管理员；其他后台角色和健管师 403（和暂停接口一致，规格 6.4） */
function requirePlatformAdmin(session: ResolvedSession): void {
  requireExpertViewer(session);
  if (session.role !== 'platform_admin') throw forbidden();
}

/**
 * 专家后台接口（M3 规格 1.3、6.4，Q11、Q14）。
 * - GET /api/expert-stats：运营商看本协会，平台看全部；健管师、机构管理员 403。
 * - GET /api/admin/experts、GET /api/admin/experts/:id/availability-events：只有平台管理员。
 * 统计只来自数据库的汇总函数，不含健管师、客户、任务的 id 和意见内容。
 */
@Controller()
export class ExpertsAdminController {
  constructor(
    private readonly repo: ExpertsRepository,
    private readonly consultations: ConsultationService,
  ) {}

  @Get('expert-stats')
  async stats(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<ExpertStatsResponse> {
    requireExpertViewer(session);
    if (session.role !== 'platform_admin' && session.role !== 'operator_admin') throw forbidden();
    const platform = session.role === 'platform_admin';
    const range = parseRange(query);
    // 运营商传了别的协会也只返回本协会：这里不用它，数据库函数同样忽略
    const operatorId = platform ? range.operatorId : null;
    const rows = await this.repo.usageStats(session, { ...range, operatorId });
    const operators = platform ? await this.repo.operators(session) : [];
    const names = new Map(operators.map((o) => [o.id, o.name]));
    const totals: ExpertUsageTotal[] = [...totalsByExpert(rows)].map(([expertId, c]) => ({
      expertId,
      expertName: expertName(expertId),
      ...withRates(c),
    }));
    return {
      scope: platform ? 'platform' : 'operator',
      from: range.from,
      to: range.to,
      operatorId,
      operators,
      rows: rows.map((r) => ({
        operatorId: platform ? r.operatorId : null,
        operatorName: platform ? (names.get(r.operatorId) ?? null) : null,
        expertId: r.expertId,
        expertName: expertName(r.expertId),
        date: r.date,
        ...withRates(r),
      })),
      totals,
    };
  }

  /** 各专家的版本、知识来源指纹、状态、评测用例条数、上下架和有用/没用汇总（规格 1.3） */
  @Get('admin/experts')
  async list(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<AdminExpertListResponse> {
    requirePlatformAdmin(session);
    const range = parseRange(query);
    const [availability, rows] = await Promise.all([
      this.repo.availability(session),
      this.repo.usageStats(session, { ...range, operatorId: null }),
    ]);
    const totals = totalsByExpert(rows);
    const preview = this.consultations.preview;
    return {
      from: range.from,
      to: range.to,
      experts: EXPERTS.map((def) => {
        const id = def.meta.id;
        const state = availability.get(id);
        const t = totals.get(id);
        return {
          id,
          name: def.meta.name,
          version: def.meta.version,
          sourcesVersion: def.sources.version,
          status: def.meta.status,
          sourcesPending: sourcesPending(def),
          statusAllowed: statusAllowed(def.meta.status, preview),
          enabled: state?.enabled ?? true,
          updatedAt: state ? state.updatedAt.toISOString() : null,
          evalCases: EXPERT_EVAL_CASES[id]?.length ?? 0,
          evalTarget: EXPERT_EVAL_TARGET,
          calls: t?.calls ?? 0,
          useful: t?.useful ?? 0,
          notUseful: t?.notUseful ?? 0,
        };
      }),
    };
  }

  /** 某位专家的暂停、恢复记录（数据库触发器写入），最近 50 条 */
  @Get('admin/experts/:id/availability-events')
  async events(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ExpertAvailabilityEventListResponse> {
    requirePlatformAdmin(session);
    if (!EXPERT_ID_PATTERN.test(id)) throw notFound();
    const def = getExpert(id);
    if (!def) throw notFound();
    const rows = await this.repo.availabilityEvents(session, def.meta.id);
    return {
      events: rows.map((r) => ({
        id: r.id,
        expertId: r.expert_id,
        action: r.action,
        actorId: r.actor_id,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }
}
