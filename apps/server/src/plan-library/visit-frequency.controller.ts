import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  updateVisitFrequencyRulesRequestSchema,
  type VisitFrequencyRuleEventListResponse,
  type VisitFrequencyRulesResponse,
} from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden, notFound } from '../common/api-error.js';
import type { Role } from '../db/types.js';
import { VisitFrequencyRepository } from './visit-frequency.repository.js';

const READERS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];

function requirePlatformAdmin(session: ResolvedSession): void {
  if (!READERS.includes(session.role)) throw notFound();
  if (session.role !== 'platform_admin') throw forbidden();
}

/**
 * 随访频次规则（M5 规格 2.12、6.4、Q18）。
 * - GET /api/visit-frequency-rules：健管师、机构、协会、平台都能读，不含任何客户数据；
 * - PATCH /api/admin/visit-frequency-rules：整套替换，只有平台管理员，其他 403；超出范围 400；
 * - GET /api/admin/visit-frequency-rules/events：修改记录，只有平台管理员。
 * 改规则不改已经写入的随访日期。
 */
@Controller()
export class VisitFrequencyController {
  constructor(private readonly repo: VisitFrequencyRepository) {}

  @Get('visit-frequency-rules')
  get(@CurrentSession() session: ResolvedSession): Promise<VisitFrequencyRulesResponse> {
    // 显式列出能读的角色：以后加客户账号时，客户不会落到“200 和规则”
    if (!READERS.includes(session.role)) throw notFound();
    return this.repo.get(session);
  }

  @Patch('admin/visit-frequency-rules')
  update(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<VisitFrequencyRulesResponse> {
    requirePlatformAdmin(session);
    const parsed = updateVisitFrequencyRulesRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return this.repo.update(session, parsed.data);
  }

  @Get('admin/visit-frequency-rules/events')
  async events(
    @CurrentSession() session: ResolvedSession,
  ): Promise<VisitFrequencyRuleEventListResponse> {
    requirePlatformAdmin(session);
    return { events: await this.repo.events(session) };
  }
}
