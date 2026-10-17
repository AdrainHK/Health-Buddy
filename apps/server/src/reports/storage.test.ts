import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { newStorageKey, S3ObjectStorage } from './storage.js';

/**
 * 验收标准 23 的代码部分：对象存储的 key 不含客户姓名和原文件名；写入请求要求服务端加密、
 * 不带 ACL；只通过后端读取（不生成直链）。用假的 S3 客户端记录发出去的命令，不连真实存储。
 * 存储桶本身不公开访问是部署配置（Q5），这里测不到，要在配置对象存储时检查。
 */
describe('报告原件的对象存储', () => {
  const config = {
    endpoint: undefined,
    region: 'us-east-1',
    bucket: 'synthetic-bucket',
    accessKeyId: 'synthetic-key-id',
    secretAccessKey: 'synthetic-secret',
    forcePathStyle: false,
  };

  function fakeClient() {
    const sent: unknown[] = [];
    const client = {
      send: (command: unknown) => {
        sent.push(command);
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
          });
        }
        return Promise.resolve({});
      },
    } as unknown as S3Client;
    return { client, sent };
  }

  it('key 是随机 id：reports/ 加 32 位十六进制，每次不同', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newStorageKey()));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^reports\/[0-9a-f]{32}$/);
  });

  it('写入请求要求服务端加密，不带 ACL', async () => {
    const { client, sent } = fakeClient();
    const storage = new S3ObjectStorage(config, client);
    const key = newStorageKey();
    await storage.put(key, Buffer.from('synthetic'), 'application/pdf');
    expect(sent).toHaveLength(1);
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'synthetic-bucket',
      Key: key,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'AES256',
    });
    // 写入请求里没有 ACL、没有 Content-Disposition（不带原文件名）、没有元数据
    expect(Object.keys(put.input).sort()).toEqual(
      ['Body', 'Bucket', 'ContentType', 'Key', 'ServerSideEncryption'].sort(),
    );
  });

  it('读取由后端直接取对象内容，不生成预签名直链', async () => {
    const { client, sent } = fakeClient();
    const storage = new S3ObjectStorage(config, client);
    const body = await storage.get('reports/0123456789abcdef0123456789abcdef');
    expect([...body]).toEqual([1, 2, 3]);
    expect(sent[0]).toBeInstanceOf(GetObjectCommand);
    expect(Object.getOwnPropertyNames(S3ObjectStorage.prototype).sort()).toEqual(
      ['constructor', 'delete', 'get', 'put'].sort(),
    );
  });
});
