import { Controller, Get } from '@nestjs/common';
import type { SkillListResponse } from '@health-buddy/shared';
import { skillSummaries } from '@health-buddy/skills';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { notFound } from '../common/api-error.js';

/** 工作台技能列表。工作台只给健管师用，其他角色按“不存在”处理。 */
@Controller('skills')
export class SkillsController {
  @Get()
  list(@CurrentSession() session: ResolvedSession): SkillListResponse {
    if (session.role !== 'manager') throw notFound();
    return { skills: skillSummaries() };
  }
}
