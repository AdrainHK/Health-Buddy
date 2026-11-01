import { Controller, Get, Query } from '@nestjs/common';
import { opsDashboardQuerySchema, type OpsDashboardResponse } from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden } from '../common/api-error.js';
import { OpsDashboardRepository } from './ops-dashboard.repository.js';

/**
 * GET /api/admin/ops-dashboard?days=7|30|90&operatorId=（M7 规格 2.6、6.4）：
 * 平台、运营商管理员、机构管理员；健管师 403。operatorId 只有平台能用（别的角色传了也按本协会、本机构）。
 * 只有汇总数字。
 */
@Controller('admin/ops-dashboard')
export class OpsDashboardController {
  constructor(private readonly repo: OpsDashboardRepository) {}

  @Get()
  async get(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<OpsDashboardResponse> {
    if (!['platform_admin', 'operator_admin', 'org_admin'].includes(session.role)) {
      throw forbidden();
    }
    const parsed = opsDashboardQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw badRequest();
    return this.repo.dashboard(session, parsed.data.days, parsed.data.operatorId);
  }
}
