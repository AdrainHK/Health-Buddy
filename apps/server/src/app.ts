import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module.js';
import { originCheck } from './common/origin-check.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    // 自己注册请求体解析，才能在它后面接上不泄露请求内容的错误处理。
    bodyParser: false,
    logger: config.env === 'test' ? ['error', 'warn'] : ['log', 'error', 'warn'],
  });

  // Railway 等平台在前面有一层代理，信任一跳，req.ip 才是真实客户端地址。
  if (config.env === 'production') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.use(originCheck);
  app.use(express.json({ limit: '100kb' }));
  app.use(bodyParseErrorHandler);
  app.setGlobalPrefix('api');

  if (config.workbenchDist) serveWorkbench(app, resolve(config.workbenchDist));

  await app.init();
  return app;
}

/**
 * 请求体解析失败（JSON 格式不对、太大）时返回统一错误码。
 * 不记录错误：Node 的 JSON 解析错误消息会带上请求原文片段，可能含密码或健康数据。
 */
function bodyParseErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (!err) {
    next();
    return;
  }
  const status = typeof err === 'object' && 'status' in err && err.status === 413 ? 413 : 400;
  res.status(status).json({ error: 'bad_request' });
}

/** 由后端一并提供工作台页面，前后端同源，会话 Cookie 不需要跨站。 */
function serveWorkbench(app: NestExpressApplication, dist: string): void {
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) throw new Error('WORKBENCH_DIST 目录下找不到 index.html');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  // 单页应用：除接口外的 GET 请求都返回 index.html，由前端路由处理。
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}
