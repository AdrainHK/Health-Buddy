import { Body, Controller, Get, Put } from '@nestjs/common';
import { saveContentRulesRequestSchema, type ContentRulesResponse } from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, forbidden } from '../common/api-error.js';
import { ContentRulesRepository } from './content-rules.repository.js';

const READERS: ReadonlySet<string> = new Set(['platform_admin', 'operator_admin', 'org_admin']);

/**
 * 科普合规规则（M8 规格 3.3，Q3）：平台、协会、机构管理员可读；只有平台能保存新版本。
 * 健管师在生成和修改时由后端读规则，不经这个接口 → 403。
 */
@Controller('admin/content-rules')
export class ContentRulesController {
  constructor(private readonly repo: ContentRulesRepository) {}

  @Get()
  async get(@CurrentSession() session: ResolvedSession): Promise<ContentRulesResponse> {
    if (!READERS.has(session.role)) throw forbidden();
    return this.repo.get(session);
  }

  @Put()
  async save(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<ContentRulesResponse> {
    if (session.role !== 'platform_admin') throw forbidden();
    const parsed = saveContentRulesRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return this.repo.save(session, parsed.data);
  }
}
