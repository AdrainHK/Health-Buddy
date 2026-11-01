import { Controller, Get } from '@nestjs/common';
import type { HomeResponse } from '@health-buddy/shared';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { forbidden } from '../common/api-error.js';
import { HomeRepository } from './home.repository.js';

/**
 * 工作台首页（M8 规格 2.4、3.3）：待审核草稿和快捷入口的使用排序。
 * 只给健管师本人；机构管理员、协会管理员和平台没有首页（他们用后台）→ 403（验收 14）。
 * 伴侣预警、今日跟进、今日随访由前端分别请求现有接口，一个分区出错不影响其他分区。
 */
@Controller('home')
export class HomeController {
  constructor(private readonly repo: HomeRepository) {}

  @Get()
  async home(@CurrentSession() session: ResolvedSession): Promise<HomeResponse> {
    if (session.role !== 'manager') throw forbidden();
    return this.repo.home(session);
  }
}
