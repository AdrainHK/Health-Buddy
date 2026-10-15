import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { ApiException } from '../common/api-error.js';
import { DB } from '../db/db.provider.js';
import { pingDb, type Db } from '../db/database.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 部署平台的健康检查：服务和数据库都可用时返回 ok。 */
  @Public()
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await pingDb(this.db);
    } catch {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal_error');
    }
    return { status: 'ok' };
  }
}
