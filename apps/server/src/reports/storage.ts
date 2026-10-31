import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import type { StorageConfig } from '../config.js';

/**
 * 报告原件的对象存储（M2 规格 2.3、Q5、Q6）。
 *
 * key 是随机 id（reports/ + 32 位十六进制），不含客户姓名和原文件名。
 * 存储桶不公开访问，原件只能通过后端接口查看（验收标准 23），不生成直链。
 * 同一个桶里还有协会 Logo（brands/ 前缀，M7）：不要给桶或任何前缀配公开读、CDN 回源，
 * Logo 也只经后端公开接口读取。
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export function newStorageKey(): string {
  return `reports/${randomBytes(16).toString('hex')}`;
}

/**
 * S3 兼容的对象存储（AWS S3、Cloudflare R2、MinIO 等）。
 * 写入时要求服务端加密；不设置任何公开读权限。
 * SDK 的异常可能带请求地址，调用方只记录错误类型。
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: StorageConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('empty object');
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** 测试用的内存存储 */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  /** 设置后下一次 put 失败，用来测试“存储失败时不留记录” */
  failNextPut = false;

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error('storage unavailable'));
    }
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    return found ? Promise.resolve(Buffer.from(found.body)) : Promise.reject(new Error('missing'));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
