import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { VisitMaterialsRepository } from './visit-materials.repository.js';

/** 每小时清一次；启动 1 分钟后先清一次（经常重新部署时也不会一直不清） */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

/**
 * 随访素材原文到期删除（M5 规格 Q23）：记录确认 30 天后、未使用的素材上传 30 天后。
 * 原文在数据库列里，由数据库函数直接置空（不经 storage_purge_queue）。日志只记数量。
 */
@Injectable()
export class MaterialPurgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('VisitMaterialPurge');
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;

  constructor(private readonly repo: VisitMaterialsRepository) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.run(), PURGE_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<number> {
    try {
      const purged = await this.repo.purgeDue();
      if (purged) this.logger.log(`purged materials ${JSON.stringify({ count: purged })}`);
      return purged;
    } catch (err) {
      this.logger.error(`purge failed ${err instanceof Error ? err.name : typeof err}`);
      return 0;
    }
  }
}
