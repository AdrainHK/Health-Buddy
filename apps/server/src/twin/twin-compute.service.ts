import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { TwinComputeTrigger } from '@health-buddy/shared';
import { dbErrorCode } from '../common/db-error.js';
import { DB } from '../db/db.provider.js';
import { withTenant, type Db, type TenantContext } from '../db/database.js';
import { twinRequestAll } from '../db/twin-functions.js';
import { TwinEngine } from './twin-engine.js';
import { TWIN_QUEUE, TwinJobRejected, twinJobSchema, type TwinQueue } from './twin-queue.js';

/**
 * 孪生计算的入口（M4 规格 3.2）：数据写入后把客户标为“正在更新”并排进队列，
 * 队列任务由 TwinEngine 在客户所属健管师的上下文里执行。
 * 日志只记客户 id、触发原因、数量和错误码，不记姓名、数值、依据。
 */
@Injectable()
export class TwinComputeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('TwinCompute');
  readonly engine: TwinEngine;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TWIN_QUEUE) private readonly queue: TwinQueue,
  ) {
    this.engine = new TwinEngine(db);
  }

  onModuleInit(): void {
    this.queue.start((job) => this.process(job));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }

  /**
   * 执行一个队列任务。参数不合规（多带了租户字段、类型不对）时直接拒绝，不读任何数据；
   * all 任务把所有客户各排一个任务。
   */
  async process(raw: unknown): Promise<void> {
    const parsed = twinJobSchema.safeParse(raw);
    if (!parsed.success) throw new TwinJobRejected();
    const job = parsed.data;
    if (job.type === 'all') {
      const ids = await twinRequestAll(this.db);
      for (const clientId of ids) {
        await this.queue.enqueue({ type: 'client', clientId, trigger: job.trigger });
      }
      this.logger.log(
        `twin batch queued ${JSON.stringify({ trigger: job.trigger, clients: ids.length })}`,
      );
      return;
    }
    await this.engine.compute(job.clientId, job.trigger);
  }

  /**
   * 健管师写入数据之后调用（核对报告、更正、录入或删除监测读数、打开没算过的孪生）。
   * 在他的上下文里把客户标为“正在更新”再入队。失败只记日志，不影响已经成功的请求：
   * 下次数据变化或打开孪生时会补算。
   */
  async request(ctx: TenantContext, clientId: string, trigger: TwinComputeTrigger): Promise<void> {
    // 只有健管师写客户数据；其他角色不排任务（没有归属校验就不入队）
    if (ctx.role !== 'manager') return;
    try {
      // 行级安全兼作归属校验：不是自己的客户时写入失败，不会入队
      await withTenant(this.db, ctx, (trx) =>
        trx
          .insertInto('twin_compute_state')
          .values({
            operator_id: ctx.operatorId ?? '',
            org_id: ctx.orgId,
            manager_id: ctx.userId,
            client_id: clientId,
            requested_at: new Date(),
          })
          .onConflict((oc) => oc.column('client_id').doUpdateSet({ requested_at: new Date() }))
          .execute(),
      );
      await this.queue.enqueue({ type: 'client', clientId, trigger });
    } catch (err) {
      this.logger.error(
        `twin enqueue failed ${JSON.stringify({ clientId, trigger, error: dbErrorCode(err) })}`,
      );
    }
  }

  /**
   * 福宝打卡写入监测之后调用（M6 规格 2.3）：数据库函数已经在设备会话里把客户标为“正在更新”，
   * 这里只入队。只在 companion_checkin_reading 成功写入之后调用（客户由函数按设备绑定校验）。
   */
  async requestFromCompanion(clientId: string): Promise<void> {
    try {
      await this.queue.enqueue({ type: 'client', clientId, trigger: 'monitoring' });
    } catch (err) {
      this.logger.error(
        `twin enqueue failed ${JSON.stringify({ clientId, trigger: 'monitoring', error: dbErrorCode(err) })}`,
      );
    }
  }

  /** 平台修改状态规则或危急阈值后：所有客户在后台按新规则重算（Q22，不生成跟进项） */
  async requestAll(trigger: 'rules_changed' | 'thresholds_changed'): Promise<void> {
    try {
      await this.queue.enqueue({ type: 'all', trigger });
    } catch (err) {
      this.logger.error(
        `twin enqueue failed ${JSON.stringify({ trigger, error: dbErrorCode(err) })}`,
      );
    }
  }
}
