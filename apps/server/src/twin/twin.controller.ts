import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  createMonitoringReadingRequestSchema,
  setTwinStatusRequestSchema,
  twinDomainSchema,
  twinTimelineQuerySchema,
  type MonitoringReadingListResponse,
  type MonitoringReadingResponse,
  type TwinDomainResponse,
  type TwinForecastDetailResponse,
  type TwinLevelsResponse,
  type TwinOrgAdminResponse,
  type TwinResponse,
  type TwinStatusHistoryResponse,
  type TwinTimelineResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, conflict, notFound, tooManyRequests } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import type { LlmRateLimiter } from '../workbench/llm-rate-limiter.js';
import { TwinComputeService } from './twin-compute.service.js';
import { TwinRepository } from './twin.repository.js';

export const MONITORING_RATE_LIMITER = Symbol('MONITORING_RATE_LIMITER');

const idSchema = z.uuid();
const READING_ID_RE = /^[1-9]\d{0,17}$/;
const METRIC_RE = /^[a-z][a-z0-9_]{1,40}$/;

/** 格式不对、不存在、属于别的租户，一律返回“不存在” */
function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/** 孪生只给健管师和（只读的）机构管理员看（Q20）；运营商、平台和以后的客户角色按“不存在”处理 */
function requireTwinReader(session: ResolvedSession): void {
  if (session.role !== 'manager' && session.role !== 'org_admin') throw notFound();
}

/** types 可以是逗号分隔，也可以重复传 */
function normalizeTimelineQuery(query: Record<string, unknown>) {
  const raw = query.types;
  const types =
    raw === undefined
      ? undefined
      : (Array.isArray(raw) ? raw : [raw]).flatMap((t) => String(t).split(',')).filter(Boolean);
  return { ...query, ...(types ? { types } : {}) };
}

/**
 * 客户数字孪生接口（M4 规格 7.4）。孪生接口只读已算好的结果，不调用大模型，
 * 不计入每分钟 20 次的大模型调用上限。别人的客户一律 404。
 */
@Controller()
export class TwinController {
  constructor(
    private readonly repo: TwinRepository,
    private readonly compute: TwinComputeService,
    @Inject(MONITORING_RATE_LIMITER) private readonly limiter: LlmRateLimiter,
  ) {}

  /** 孪生主视图。机构管理员的响应用单独的、字段更少的 schema（没有预测和跟进项） */
  @Get('clients/:id/twin')
  async view(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<TwinResponse | TwinOrgAdminResponse> {
    requireTwinReader(session);
    const clientId = parseId(id);
    if (session.role === 'org_admin') {
      const view = await this.repo.orgAdminView(session, clientId);
      if (!view) throw notFound();
      return view;
    }
    const result = await this.repo.managerView(session, clientId);
    if (!result) throw notFound();
    // M4 上线前已有数据、还没算过的客户：打开时补算（按批量处理，不生成跟进项）
    if (result.neverComputed && result.view.hasData) {
      await this.compute.request(session, clientId, 'backfill');
      return { ...result.view, computing: true };
    }
    return result.view;
  }

  /** 左侧栏客户列表的状态圆点（2.1）：只给健管师，其他角色 404 */
  @Get('twin/levels')
  async levels(@CurrentSession() session: ResolvedSession): Promise<TwinLevelsResponse> {
    requireManager(session);
    return { clients: await this.repo.clientLevels(session) };
  }

  @Get('clients/:id/twin/timeline')
  async timeline(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<TwinTimelineResponse> {
    requireTwinReader(session);
    const clientId = parseId(id);
    const parsed = twinTimelineQuerySchema.safeParse(normalizeTimelineQuery(query ?? {}));
    if (!parsed.success) throw badRequest();
    const timeline = await this.repo.timeline(session, clientId, parsed.data);
    if (!timeline) throw notFound();
    return timeline;
  }

  /** 预测大图：只给健管师（Q20） */
  @Get('clients/:id/twin/forecasts/:metric')
  async forecast(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('metric') metric: string,
  ): Promise<TwinForecastDetailResponse> {
    requireManager(session);
    const clientId = parseId(id);
    if (!METRIC_RE.test(metric)) throw notFound();
    const detail = await this.repo.forecastDetail(session, clientId, metric);
    if (!detail) throw notFound();
    return detail;
  }

  @Get('clients/:id/twin/status-history')
  async statusHistory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Query('domain') domain: string | undefined,
  ): Promise<TwinStatusHistoryResponse> {
    requireTwinReader(session);
    const clientId = parseId(id);
    const parsed = domain === undefined ? undefined : twinDomainSchema.safeParse(domain);
    if (parsed && !parsed.success) throw badRequest();
    const records = await this.repo.statusHistory(session, clientId, parsed?.data);
    if (!records) throw notFound();
    return { records };
  }

  /** 手动调整状态，理由必填（Q4）。机构管理员只读 → 404；请求体里的租户字段一律忽略 */
  @Post('clients/:id/twin/status')
  @HttpCode(200)
  async setStatus(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TwinDomainResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = setTwinStatusRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const domain = await this.repo.setManual(session, clientId, parsed.data);
    if (!domain) throw notFound();
    return { domain };
  }

  /** 取消手动调整，恢复系统计算。没有生效中的手动调整 → 409 */
  @Delete('clients/:id/twin/status/:domain')
  async clearStatus(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('domain') domain: string,
  ): Promise<TwinDomainResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = twinDomainSchema.safeParse(domain);
    if (!parsed.success) throw notFound();
    const result = await this.repo.clearManual(session, clientId, parsed.data);
    if (!result) throw notFound();
    if (result === 'none') throw conflict();
    return { domain: result };
  }

  /** 手动录入一条监测读数（Q29）。每位健管师每分钟最多 60 条 */
  @Post('clients/:id/monitoring-readings')
  async createReading(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MonitoringReadingResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = createMonitoringReadingRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    if (!this.limiter.tryAcquire(session.userId)) throw tooManyRequests(['manual_readings']);
    const reading = await this.repo.createReading(session, clientId, parsed.data);
    if (!reading) throw notFound();
    await this.compute.request(session, clientId, 'monitoring');
    return { reading };
  }

  /** 自己给这位客户手动录入的读数（用来删除录错的，Q29）。别人的客户、机构管理员 → 404 */
  @Get('clients/:id/manual-readings')
  async manualReadings(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<MonitoringReadingListResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const readings = await this.repo.manualReadings(session, clientId);
    if (!readings) throw notFound();
    return { readings };
  }

  /** 删除自己手动录入的读数；合成、伴侣、设备数据不能删 → 409 */
  @Delete('monitoring-readings/:id')
  @HttpCode(204)
  async deleteReading(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<void> {
    requireManager(session);
    if (!READING_ID_RE.test(id)) throw notFound();
    const result = await this.repo.deleteReading(session, id);
    if (result === 'not_found') throw notFound();
    if (result === 'not_manual') throw conflict();
    await this.compute.request(session, result.clientId, 'monitoring');
  }
}
