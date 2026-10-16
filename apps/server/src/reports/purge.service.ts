import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ReportsRepository } from './reports.repository.js';
import { OBJECT_STORAGE, type ObjectStorage } from './storage.js';

/** 每小时清一次（Q6 要求客户删除后 30 天内清除原件） */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** 客户删除后，定期从对象存储删除他的报告原件（Q6）。日志只记数量 */
@Injectable()
export class PurgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ReportPurge');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: ReportsRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  onModuleInit(): void {
    if (!this.storage || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run(), PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    if (!this.storage) return 0;
    try {
      const purged = await this.repo.purgeBatch(this.storage);
      if (purged) this.logger.log(`purged originals ${JSON.stringify({ count: purged })}`);
      return purged;
    } catch (err) {
      this.logger.error(`purge failed ${err instanceof Error ? err.name : typeof err}`);
      return 0;
    }
  }
}
