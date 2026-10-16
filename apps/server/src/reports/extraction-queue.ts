import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * 报告识别队列（M2 规格 2.3 第 3 条、3.2“识别过程中的租户上下文”）。
 *
 * 任务参数只有 upload_id 和第几次识别：不带租户信息、客户姓名、文件名或任何内容。
 * 执行时由 ExtractionService 从数据库重新读取发起人的身份，以他的租户上下文读写。
 * attempt 必须等于记录当前的识别次数才能认领，同一次识别的重复任务读不到。
 */
export interface ExtractionJob {
  uploadId: string;
  attempt: number;
}

export type ExtractionProcessor = (job: ExtractionJob) => Promise<void>;

export interface ExtractionQueue {
  /** 没有配置 Redis 时为 false，上传和重新识别接口返回“未配置” */
  readonly configured: boolean;
  /** 任务 id 由 upload_id 和 attempt 组成，同一次识别不会重复入队 */
  enqueue(job: ExtractionJob): Promise<void>;
  /** 由 ExtractionService 启动时注册处理函数 */
  start(processor: ExtractionProcessor): void;
  close(): Promise<void>;
}

export const EXTRACTION_QUEUE = Symbol('EXTRACTION_QUEUE');

const QUEUE_NAME = 'report-extraction';
/** 同一个实例同时识别几份报告 */
const CONCURRENCY = 2;

/** BullMQ 实现。Worker 和接口在同一个进程里（部署只有一个服务） */
export class BullMqExtractionQueue implements ExtractionQueue {
  readonly configured = true;
  private readonly logger = new Logger('ExtractionQueue');
  private readonly connection: Redis;
  private readonly queue: Queue<ExtractionJob>;
  private worker: Worker<ExtractionJob> | undefined;
  private workerConnection: Redis | undefined;

  constructor(private readonly redisUrl: string) {
    this.connection = this.connect();
    this.queue = new Queue<ExtractionJob>(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        // 重试由健管师手动发起（最多 3 次），队列自己不重试
        attempts: 1,
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

  async enqueue(job: ExtractionJob): Promise<void> {
    await this.queue.add(
      'extract',
      { uploadId: job.uploadId, attempt: job.attempt },
      { jobId: `${job.uploadId}-${job.attempt}` },
    );
  }

  start(processor: ExtractionProcessor): void {
    if (this.worker) return;
    this.workerConnection = this.connect();
    this.worker = new Worker<ExtractionJob>(
      QUEUE_NAME,
      async (job) => processor({ uploadId: job.data.uploadId, attempt: job.data.attempt }),
      { connection: this.workerConnection, concurrency: CONCURRENCY },
    );
    // 失败只记任务 id（含 upload_id）和错误类型，不记错误消息
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`extraction job failed id=${job?.id ?? 'unknown'} error=${err.name}`);
    });
    this.worker.on('error', (err) => this.logger.error(`extraction worker error ${err.name}`));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
    this.workerConnection?.disconnect();
  }
}

/** 没有配置 Redis 时用：不接受任务 */
export class DisabledExtractionQueue implements ExtractionQueue {
  readonly configured = false;
  enqueue(): Promise<void> {
    return Promise.reject(new Error('extraction queue not configured'));
  }
  start(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * 测试用：不需要 Redis，在当前进程里异步执行，记录每个任务的参数和结果。
 * idle() 等所有已入队的任务执行完。
 */
export class InlineExtractionQueue implements ExtractionQueue {
  readonly configured = true;
  readonly jobs: {
    data: ExtractionJob;
    attempt: number;
    scheduled?: boolean;
    outcome?: 'completed' | 'failed';
  }[] = [];
  private processor: ExtractionProcessor | undefined;
  private pending = new Set<Promise<void>>();
  /** 设置后入队不执行，用来测试“排队中”的状态 */
  paused = false;
  /** 设置后下一次入队失败，用来测试“入队失败时退还页数” */
  failNextEnqueue = false;

  enqueue(job: ExtractionJob): Promise<void> {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    const entry: (typeof this.jobs)[number] = {
      data: { uploadId: job.uploadId, attempt: job.attempt },
      attempt: job.attempt,
    };
    this.jobs.push(entry);
    if (!this.paused) this.schedule(entry);
    return Promise.resolve();
  }

  start(processor: ExtractionProcessor): void {
    this.processor = processor;
  }

  /** 执行一个任务（也用来模拟构造出来的任务），返回结果 */
  async run(data: ExtractionJob): Promise<'completed' | 'failed'> {
    if (!this.processor) throw new Error('no processor');
    try {
      await this.processor(data);
      return 'completed';
    } catch {
      return 'failed';
    }
  }

  /** 把暂停期间入队的任务都执行掉 */
  resume(): void {
    this.paused = false;
    for (const entry of this.jobs) if (!entry.scheduled) this.schedule(entry);
  }

  private schedule(entry: (typeof this.jobs)[number]): void {
    entry.scheduled = true;
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(entry.data))
      .then((outcome) => {
        entry.outcome = outcome;
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  close(): Promise<void> {
    return this.idle();
  }
}
