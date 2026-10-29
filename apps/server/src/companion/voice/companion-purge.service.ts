import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DialogueRepository } from './dialogue.repository.js';

/** 每小时清一次；启动 1 分钟后先清一次（经常重新部署时也不会一直不清） */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

/**
 * 伴侣聊天文字和记忆到期删除（M6 N19、Q5）：聊天文字 180 天后，撤回同意的客户 7 天后
 * （记忆同样）。由数据库函数直接删除。日志只记数量。
 */
@Injectable()
export class CompanionPurgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('CompanionPurge');
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;

  constructor(private readonly repo: DialogueRepository) {}

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

  async run(): Promise<{ messages: number; memories: number }> {
    try {
      const purged = await this.repo.purge();
      if (purged.messages || purged.memories) {
        this.logger.log(`purged companion data ${JSON.stringify(purged)}`);
      }
      return purged;
    } catch (err) {
      this.logger.error(`companion purge failed ${err instanceof Error ? err.name : typeof err}`);
      return { messages: 0, memories: 0 };
    }
  }
}
