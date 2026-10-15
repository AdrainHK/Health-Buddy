import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createCriticalThresholdRequestSchema,
  updateCriticalThresholdRequestSchema,
  type CriticalThreshold,
  type CriticalThresholdListResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, notFound } from '../common/api-error.js';
import type { Role } from '../db/types.js';
import { CriticalThresholdsRepository } from './critical-thresholds.repository.js';

const idSchema = z.uuid();
const READERS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];

/** 改阈值只对平台管理员开放，其他角色按“不存在”处理。行级安全是第二道防线。 */
function requirePlatformAdmin(session: ResolvedSession): void {
  if (session.role !== 'platform_admin') throw notFound();
}

/** 危急指标阈值：全平台一套（Q12）。所有后台角色和健管师都能读，只有平台管理员能改。 */
@Controller('critical-thresholds')
export class CriticalThresholdsController {
  constructor(private readonly repo: CriticalThresholdsRepository) {}

  @Get()
  async list(@CurrentSession() session: ResolvedSession): Promise<CriticalThresholdListResponse> {
    // 显式列出能读的角色：以后加客户账号时，客户不会落到“200 和空列表”
    if (!READERS.includes(session.role)) throw notFound();
    return { thresholds: await this.repo.list(session) };
  }

  @Post()
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<{ threshold: CriticalThreshold }> {
    requirePlatformAdmin(session);
    const parsed = createCriticalThresholdRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { threshold: await this.repo.create(session, parsed.data) };
  }

  @Post('reset')
  @HttpCode(200)
  async reset(@CurrentSession() session: ResolvedSession): Promise<CriticalThresholdListResponse> {
    requirePlatformAdmin(session);
    return { thresholds: await this.repo.resetToDefaults(session) };
  }

  @Patch(':id')
  async patch(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ threshold: CriticalThreshold }> {
    requirePlatformAdmin(session);
    if (!idSchema.safeParse(id).success) throw notFound();
    const parsed = updateCriticalThresholdRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const threshold = await this.repo.update(session, id, parsed.data);
    if (!threshold) throw notFound();
    return { threshold };
  }
}
