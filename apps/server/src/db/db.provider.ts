import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { createDb, type Db } from './database.js';

export const DB = Symbol('DB');

@Injectable()
class DbCloser implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/** 应用运行时的数据库连接，使用受行级安全约束的 hb_app 角色。 */
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Db => createDb(config.appDatabaseUrl),
    },
    DbCloser,
  ],
  exports: [DB],
})
export class DbModule {}
