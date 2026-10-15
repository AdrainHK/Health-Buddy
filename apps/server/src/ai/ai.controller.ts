import { Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { notFound } from '../common/api-error.js';
import { LLM_GATEWAY, type AppGateway } from './gateway.provider.js';

/** 部署后检查大模型是否连通。提示词固定，不含任何客户数据。 */
const SMOKE_PROMPT = 'Reply with one short sentence confirming you are reachable.';

@Controller('ai')
export class AiController {
  constructor(@Inject(LLM_GATEWAY) private readonly gateway: AppGateway) {}

  /**
   * 连通性检查，只对平台管理员开放，以服务端推送事件（SSE）流式返回。
   * 其他角色返回“不存在”。
   */
  @Post('smoke')
  @HttpCode(200)
  async smoke(@CurrentSession() session: ResolvedSession, @Res() res: Response): Promise<void> {
    if (session.role !== 'platform_admin') throw notFound();

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.flushHeaders();

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      for await (const event of this.gateway.stream(
        session,
        {
          route: 'smoke',
          messages: [{ role: 'user', content: SMOKE_PROMPT }],
          maxOutputTokens: 2000,
        },
        abort.signal,
      )) {
        send(event);
      }
    } catch (err) {
      const kind =
        err && typeof err === 'object' && 'kind' in err ? String(err.kind) : 'provider_error';
      send({ type: 'error', kind });
    }
    res.end();
  }
}
