import { PlanFeatureGuard, RequiresFeature } from '../plans/plan-feature.guard.js';
import { Body, Controller, Get, HttpCode, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { expertDetail, expertSummary, getExpert, isAvailable } from '@health-buddy/experts';
import {
  EXPERT_ID_PATTERN,
  expertFeedbackRequestSchema,
  setExpertAvailabilityRequestSchema,
  type ExpertConsultation,
  type ExpertConsultationListResponse,
  type ExpertDetail,
  type ExpertListResponse,
} from '@health-buddy/shared';
import { availableExperts } from '@health-buddy/experts';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, conflict, forbidden, notFound } from '../common/api-error.js';
import { requireExpertViewer, requireManager } from '../common/manager-only.js';
import { ConsultationService } from './consultation.service.js';
import { ExpertsRepository } from './experts.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

function parseExpertId(id: string): string {
  if (!EXPERT_ID_PATTERN.test(id)) throw notFound();
  return id;
}

/**
 * 专家中心接口（M3 规格 6.4）。专家定义是平台级的代码，所有租户看到同一套；
 * 专家调用、意见、反馈只对健管师本人开放，别人的一律 404。
 * 专家只面向健管师和后台账号，客户角色（M6 起）没有任何专家接口（规格 7.2 第 2 条）。
 */
// 套餐没有专家中心时，健管师的写操作 403（M7 规格 2.5 第 4 条），只读照常
@UseGuards(PlanFeatureGuard)
@RequiresFeature('experts')
@Controller()
export class ExpertsController {
  constructor(
    private readonly repo: ExpertsRepository,
    private readonly consultations: ConsultationService,
  ) {}

  /** 当前账号可用的专家：正式环境只有 published 且未暂停的；预览环境含 review（Q2） */
  @Get('experts')
  async list(@CurrentSession() session: ResolvedSession): Promise<ExpertListResponse> {
    requireExpertViewer(session);
    const env = {
      preview: this.consultations.preview,
      paused: await this.repo.pausedExperts(session),
    };
    return { experts: availableExperts(env).map((e) => expertSummary(e, env)) };
  }

  /** 专家详情和来源清单。不存在、已暂停、当前环境不可用都按 404 */
  @Get('experts/:id')
  async detail(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<{ expert: ExpertDetail }> {
    requireExpertViewer(session);
    const def = getExpert(parseExpertId(id));
    const env = {
      preview: this.consultations.preview,
      paused: await this.repo.pausedExperts(session),
    };
    if (!def || !isAvailable(def, env)) throw notFound();
    const usage = session.role === 'manager' ? await this.repo.usageCount(session, def.meta.id) : 0;
    return { expert: expertDetail(def, env, usage) };
  }

  /** 任务里的专家调用（专家标签） */
  @Get('tasks/:id/expert-consultations')
  async listForTask(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ExpertConsultationListResponse> {
    requireManager(session);
    const consultations = await this.repo.listForTask(session, parseId(id));
    if (!consultations) throw notFound();
    return { consultations };
  }

  /** 一次调用的详情：路由、每位专家的意见和引用、汇总、分歧 */
  @Get('expert-consultations/:id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<{ consultation: ExpertConsultation }> {
    requireManager(session);
    const consultation = await this.repo.get(session, parseId(id));
    if (!consultation) throw notFound();
    return { consultation };
  }

  /** 有用/没用（Q14），可以改 */
  @Put('expert-calls/:id/feedback')
  @HttpCode(204)
  async feedback(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    requireManager(session);
    const callId = parseId(id);
    const parsed = expertFeedbackRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const result = await this.repo.setFeedback(session, callId, parsed.data);
    if (result === 'missing') throw notFound();
    if (result === 'conflict') throw conflict();
  }

  /** 平台管理员暂停或恢复专家（Q11），每次都有记录 */
  @Patch('admin/experts/:id/availability')
  @HttpCode(204)
  async setAvailability(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    requireExpertViewer(session);
    if (session.role !== 'platform_admin') throw forbidden();
    const def = getExpert(parseExpertId(id));
    if (!def) throw notFound();
    const parsed = setExpertAvailabilityRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    await this.repo.setAvailability(session, def.meta.id, parsed.data.enabled);
  }
}
