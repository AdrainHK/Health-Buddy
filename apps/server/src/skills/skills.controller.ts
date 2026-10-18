import { Controller, Get, Inject } from '@nestjs/common';
import type { SkillListResponse } from '@health-buddy/shared';
import { skillSummaries } from '@health-buddy/skills';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { requireManager } from '../common/manager-only.js';
import { APP_CONFIG, type AppConfig } from '../config.js';

/** 工作台技能列表。工作台只给健管师用，其他角色按“不存在”处理。 */
@Controller('skills')
export class SkillsController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  list(@CurrentSession() session: ResolvedSession): SkillListResponse {
    requireManager(session);
    // 专家预览关闭时 /体检解读 显示为不调用专家（M3 Q2）
    return { skills: skillSummaries(this.config.expertsPreview) };
  }
}
