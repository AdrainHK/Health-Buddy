import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  TWIN_STATS_DEFAULT_DAYS,
  TWIN_STATS_MAX_DAYS,
  createTwinStatusRuleRequestSchema,
  twinStatsQuerySchema,
  updateTwinStatusRuleRequestSchema,
  type TwinRulesResponse,
  type TwinStatsResponse,
  type TwinStatusRuleResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden, notFound } from '../common/api-error.js';
import type { Role } from '../db/types.js';
import { TwinComputeService } from './twin-compute.service.js';
import { TwinRulesRepository } from './twin-rules.repository.js';

const idSchema = z.uuid();
const READERS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** 维护规则只对平台管理员开放；其他角色 403（按角色拒绝，不涉及任何资源） */
function requirePlatformAdmin(session: ResolvedSession): void {
  if (!READERS.includes(session.role)) throw notFound();
  if (session.role !== 'platform_admin') throw forbidden();
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 统计的日期范围（UTC 自然日，含首尾）。不传时默认最近 30 天，最长 366 天 */
function parseRange(query: unknown): { from: string; to: string; operatorId: string | null } {
  const parsed = twinStatsQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw badRequest();
  const to = parsed.data.to ?? isoDay(new Date());
  const from =
    parsed.data.from ?? isoDay(new Date(Date.parse(to) - (TWIN_STATS_DEFAULT_DAYS - 1) * DAY_MS));
  for (const d of [from, to]) {
    const t = Date.parse(d);
    if (Number.isNaN(t) || isoDay(new Date(t)) !== d) throw badRequest();
  }
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0 || span >= TWIN_STATS_MAX_DAYS) throw badRequest();
  return { from, to, operatorId: parsed.data.operatorId ?? null };
}

/**
 * 孪生状态规则和统计（M4 规格 2.10、7.4）。
 * - GET /api/twin-status-rules：健管师、机构、协会、平台都能读，不含任何客户数据；
 * - POST、PATCH /api/admin/twin-status-rules[/:id]、POST .../reset：只有平台管理员，其他 403；
 *   修改后所有客户在后台队列里按新规则重算（Q22，不在请求里同步做，不生成跟进项）；
 * - GET /api/twin-stats：运营商看本协会，平台看全部；健管师、机构管理员 403。
 */
@Controller()
export class TwinRulesController {
  constructor(
    private readonly repo: TwinRulesRepository,
    private readonly compute: TwinComputeService,
  ) {}

  @Get('twin-status-rules')
  async list(@CurrentSession() session: ResolvedSession): Promise<TwinRulesResponse> {
    // 显式列出能读的角色：以后加客户账号时，客户不会落到“200 和规则列表”
    if (!READERS.includes(session.role)) throw notFound();
    return this.repo.list(session);
  }

  @Post('admin/twin-status-rules')
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<TwinStatusRuleResponse> {
    requirePlatformAdmin(session);
    const parsed = createTwinStatusRuleRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const rule = await this.repo.create(session, parsed.data);
    await this.compute.requestAll('rules_changed');
    return { rule };
  }

  @Post('admin/twin-status-rules/reset')
  @HttpCode(200)
  async reset(@CurrentSession() session: ResolvedSession): Promise<TwinRulesResponse> {
    requirePlatformAdmin(session);
    const result = await this.repo.reset(session);
    await this.compute.requestAll('rules_changed');
    return result;
  }

  @Patch('admin/twin-status-rules/:id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TwinStatusRuleResponse> {
    requirePlatformAdmin(session);
    if (!idSchema.safeParse(id).success) throw notFound();
    const parsed = updateTwinStatusRuleRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const rule = await this.repo.update(session, id, parsed.data);
    if (!rule) throw notFound();
    await this.compute.requestAll('rules_changed');
    return { rule };
  }

  @Get('twin-stats')
  async stats(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<TwinStatsResponse> {
    if (!READERS.includes(session.role)) throw notFound();
    if (session.role !== 'platform_admin' && session.role !== 'operator_admin') throw forbidden();
    const platform = session.role === 'platform_admin';
    const range = parseRange(query);
    // 运营商传了别的协会也只返回本协会：这里不用它，数据库函数同样忽略
    const operatorId = platform ? range.operatorId : null;
    const rows = await this.repo.stats(session, { ...range, operatorId });
    const operators = platform ? await this.repo.operators(session) : [];
    const names = new Map(operators.map((o) => [o.id, o.name]));
    const totals = {
      opens: 0,
      followUpsCreated: 0,
      done: 0,
      snoozed: 0,
      dismissed: 0,
      reopened: 0,
      summaries: 0,
    };
    for (const r of rows)
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
    return {
      scope: platform ? 'platform' : 'operator',
      from: range.from,
      to: range.to,
      operatorId,
      operators,
      rows: rows.map((r) => ({
        operatorId: platform ? r.operatorId : null,
        operatorName: platform ? (names.get(r.operatorId) ?? null) : null,
        date: r.date,
        opens: r.opens,
        followUpsCreated: r.followUpsCreated,
        done: r.done,
        snoozed: r.snoozed,
        dismissed: r.dismissed,
        reopened: r.reopened,
        summaries: r.summaries,
      })),
      totals,
    };
  }
}
