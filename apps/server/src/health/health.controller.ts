import { Controller, Get, HttpStatus, Inject, Logger } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { ApiException } from '../common/api-error.js';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { pingDb, type Db } from '../db/database.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(@Inject(DB) private readonly db: Db) {}

  /** 部署平台的健康检查：服务和数据库都可用时返回 ok。 */
  @Public()
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await pingDb(this.db);
    } catch (err) {
      // 只记录错误码，便于在部署平台的日志里判断是连不上、认证失败还是表不存在。
      this.logger.warn(`数据库检查失败：${dbErrorCode(err)}`);
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, 'internal_error');
    }
    return { status: 'ok' };
  }
}
