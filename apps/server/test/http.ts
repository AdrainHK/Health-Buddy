import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { AppOptions } from '../src/app.module.js';
import type { AppConfig } from '../src/config.js';
import { testConfig } from './env.js';
import { PASSWORD } from './fixtures.js';

export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  options: AppOptions = {},
): Promise<INestApplication> {
  return createApp(testConfig(overrides), options);
}

/** 登录并返回一个自动带会话 Cookie 的请求代理。 */
export async function loginAs(app: INestApplication, email: string) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}
