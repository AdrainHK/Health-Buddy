import { Logger } from '@nestjs/common';
import { TWIN_COMPUTE_TRIGGERS } from '@health-buddy/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * 孪生计算队列（M4 规格 3.2）。任务参数只有客户 id 和触发原因（类型），
 * 不带租户信息、姓名、数值；执行时由 TwinEngine 从数据库重新找出客户的健管师，以他的上下文读写。
 * - client：算一位客户；
 * - all：规则或危急阈值修改后，把所有客户各排一个 client 任务（批量，不生成跟进项）。
 */
export const twinJobSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('client'),
      clientId: z.uuid(),
      trigger: z.enum(TWIN_COMPUTE_TRIGGERS),
    })
    .strict(),
  z
    .object({
      type: z.literal('all'),
      trigger: z.enum(['rules_changed', 'thresholds_changed']),
    })
    .strict(),
]);
export type TwinJob = z.infer<typeof twinJobSchema>;

export type TwinJobProcessor = (job: unknown) => Promise<void>;

export interface TwinQueue {
  enqueue(job: TwinJob): Promise<void>;
  /** 由 TwinComputeService 启动时注册处理函数 */
  start(processor: TwinJobProcessor): void;
  close(): Promise<void>;
}

export const TWIN_QUEUE = Symbol('TWIN_QUEUE');

/** 任务被拒绝（参数不对、客户不存在、健管师不在职、客户已转出）：不重试 */
export class TwinJobRejected extends Error {
  constructor() {
    super('twin job rejected');
    this.name = 'TwinJobRejected';
  }
}

const QUEUE_NAME = 'twin-compute';
const CONCURRENCY = 2;

/** BullMQ 实现。Worker 和接口在同一个进程里（部署只有一个服务） */
export class BullMqTwinQueue implements TwinQueue {
  private readonly logger = new Logger('TwinQueue');
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | undefined;
  private workerConnection: Redis | undefined;

  constructor(private readonly redisUrl: string) {
    this.connection = this.connect();
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        // 计算是确定性的，数据库一时出错时重试一次
        attempts: 2,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
      },
    });
  }

  /** 连接错误只记错误码，不记地址（可能含密码） */
  private connect(): Redis {
    const redis = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    redis.on('error', (err: unknown) => {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
      this.logger.error(`redis error code=${code}`);
    });
    return redis;
  }

  async enqueue(job: TwinJob): Promise<void> {
    await this.queue.add(job.type, twinJobSchema.parse(job));
  }

  start(processor: TwinJobProcessor): void {
    if (this.worker) return;
    this.workerConnection = this.connect();
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          await processor(job.data);
        } catch (err) {
          // 被拒绝的任务不重试
          if (err instanceof TwinJobRejected) throw new UnrecoverableError('twin job rejected');
          throw err;
        }
      },
      { connection: this.workerConnection, concurrency: CONCURRENCY },
    );
    // 失败只记任务 id 和错误类型，不记错误消息和参数
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`twin job failed id=${job?.id ?? 'unknown'} error=${err.name}`);
    });
    this.worker.on('error', (err) => this.logger.error(`twin worker error ${err.name}`));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
    this.workerConnection?.disconnect();
  }
}

/**
 * 没有配置 Redis 时（本地开发、测试）：在当前进程里按顺序异步执行，记录每个任务的参数和结果。
 * 孪生计算不调用大模型，没有 Redis 也照常工作；进程重启时未执行的任务丢失，
 * 下次数据变化或打开孪生时会补算。
 */
export class InProcessTwinQueue implements TwinQueue {
  private readonly logger = new Logger('TwinQueue');
  readonly jobs: { data: TwinJob; outcome?: 'completed' | 'failed' }[] = [];
  private processor: TwinJobProcessor | undefined;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** 设置后入队不执行（测试“正在更新”） */
  paused = false;
  private held: (typeof this.jobs)[number][] = [];

  enqueue(job: TwinJob): Promise<void> {
    const entry = { data: twinJobSchema.parse(job) };
    this.jobs.push(entry);
    // 只保留最近的记录，防止长时间运行时内存只增不减
    if (this.jobs.length > 5000) this.jobs.splice(0, this.jobs.length - 5000);
    if (this.paused) this.held.push(entry);
    else this.schedule(entry);
    return Promise.resolve();
  }

  start(processor: TwinJobProcessor): void {
    this.processor = processor;
  }

  /** 执行一个任务（也用来模拟构造出来的任务），返回结果 */
  async run(data: unknown): Promise<'completed' | 'failed'> {
    if (!this.processor) throw new Error('no processor');
    try {
      await this.processor(data);
      return 'completed';
    } catch (err) {
      if (!(err instanceof TwinJobRejected)) {
        this.logger.warn(`twin job failed error=${err instanceof Error ? err.name : 'unknown'}`);
      }
      return 'failed';
    }
  }

  resume(): void {
    this.paused = false;
    const held = this.held;
    this.held = [];
    for (const entry of held) this.schedule(entry);
  }

  private schedule(entry: (typeof this.jobs)[number]): void {
    this.pending++;
    this.chain = this.chain
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.run(entry.data))
      .then((outcome) => {
        entry.outcome = outcome;
      })
      .finally(() => {
        this.pending--;
      });
  }

  /** 等所有已入队的任务（包括执行中再入队的）执行完 */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.chain;
  }

  close(): Promise<void> {
    return this.idle();
  }
}
