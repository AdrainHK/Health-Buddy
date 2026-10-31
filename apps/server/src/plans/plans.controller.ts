import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createPlanRequestSchema,
  setOperatorPlansRequestSchema,
  updateAccountRequestSchema,
  updatePlanRequestSchema,
  type MyPlanResponse,
  type OperatorPlansResponse,
  type PlanListResponse,
  type PlanResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden, notFound } from '../common/api-error.js';
import { PlansRepository } from './plans.repository.js';

const idSchema = z.uuid();
function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}
function requirePlatform(session: ResolvedSession): void {
  if (session.role !== 'platform_admin') throw forbidden();
}
function requireOperatorAdmin(session: ResolvedSession): void {
  if (session.role !== 'operator_admin' || !session.operatorId) throw forbidden();
}

/**
 * 套餐（M7 规格 2.5、6.4）。
 * - GET /api/admin/plans：平台看全部（带使用人数）；运营商管理员只看本协会可售的；其他 403。
 * - POST/PATCH /api/admin/plans[/:id]、POST .../retire、GET/PUT /api/admin/operators/:id/plans：只有平台。
 * - PATCH /api/admin/accounts/:id：运营商管理员给本协会的健管师换套餐（别的协会的 404）。
 * - GET /api/me/plan：健管师自己的套餐、到期日、本月用量。
 */
@Controller()
export class PlansController {
  constructor(private readonly repo: PlansRepository) {}

  @Get('admin/plans')
  async list(@CurrentSession() session: ResolvedSession): Promise<PlanListResponse> {
    if (session.role !== 'platform_admin') requireOperatorAdmin(session);
    return { plans: await this.repo.list(session) };
  }

  @Post('admin/plans')
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<PlanResponse> {
    requirePlatform(session);
    const parsed = createPlanRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { plan: await this.repo.create(session, parsed.data) };
  }

  @Patch('admin/plans/:id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PlanResponse> {
    requirePlatform(session);
    const parsed = updatePlanRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const plan = await this.repo.update(session, parseId(id), parsed.data);
    if (!plan) throw notFound();
    return { plan };
  }

  @Post('admin/plans/:id/retire')
  @HttpCode(200)
  async retire(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<PlanResponse> {
    requirePlatform(session);
    const plan = await this.repo.retire(session, parseId(id));
    if (!plan) throw notFound();
    return { plan };
  }

  @Get('admin/operators/:id/plans')
  async operatorPlans(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<OperatorPlansResponse> {
    requirePlatform(session);
    const planIds = await this.repo.operatorPlans(session, parseId(id));
    if (!planIds) throw notFound();
    return { planIds };
  }

  @Put('admin/operators/:id/plans')
  async setOperatorPlans(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OperatorPlansResponse> {
    requirePlatform(session);
    const parsed = setOperatorPlansRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const planIds = await this.repo.setOperatorPlans(session, parseId(id), parsed.data.planIds);
    if (!planIds) throw notFound();
    return { planIds };
  }

  @Patch('admin/accounts/:id')
  async assign(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    requireOperatorAdmin(session);
    const parsed = updateAccountRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    if (!(await this.repo.assign(session, parseId(id), parsed.data.planId))) throw notFound();
    return { ok: true };
  }

  @Get('me/plan')
  async myPlan(@CurrentSession() session: ResolvedSession): Promise<MyPlanResponse> {
    if (session.role !== 'manager') throw forbidden();
    const plan = await this.repo.myPlan(session);
    if (!plan) throw notFound();
    return { plan };
  }
}
