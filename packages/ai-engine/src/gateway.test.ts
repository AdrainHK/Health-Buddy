import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadGatewayConfig } from './config.js';
import { GatewayError } from './errors.js';
import { LlmGateway } from './gateway.js';
import { MockProvider, type MockScript } from './providers/mock.js';
import type { GatewayEvent, GatewayLogger, GatewayRequest, UsageRecord } from './types.js';

const PROMPT = '客户张某某空腹血糖 7.8 mmol/L，请解读';
const ctx = { operatorId: 'op-1', userId: 'user-1' };
const request: GatewayRequest = {
  route: 'report_interpretation',
  system: '你是健康管理助手',
  messages: [{ role: 'user', content: PROMPT }],
};

function setup(script: MockScript | MockScript[] = {}, env: NodeJS.ProcessEnv = {}) {
  const provider = new MockProvider('openai', script);
  const records: UsageRecord[] = [];
  const logs: unknown[] = [];
  const logger: GatewayLogger = {
    info: (message, fields) => logs.push({ message, fields }),
    error: (message, fields) => logs.push({ message, fields }),
  };
  let t = 1000;
  const gateway = new LlmGateway({
    config: loadGatewayConfig(env),
    providers: { openai: provider },
    recordUsage: (r) => {
      records.push(r);
    },
    logger,
    now: () => (t += 50),
  });
  return { gateway, provider, records, logs };
}

async function collect(stream: AsyncIterable<GatewayEvent>) {
  const events: GatewayEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe('LlmGateway', () => {
  it('streams text deltas and finishes with usage', async () => {
    const { gateway } = setup({
      chunks: ['a', 'b'],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const events = await collect(gateway.stream(ctx, request));
    expect(events).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
      {
        type: 'done',
        finishReason: 'complete',
        usage: { inputTokens: 100, outputTokens: 20 },
        model: 'gpt-6.1-sol',
      },
    ]);
  });

  it('records usage with tenant, route, model, tokens and cost', async () => {
    const { gateway, records } = setup({
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    });
    await collect(gateway.stream(ctx, request));
    expect(records).toEqual([
      {
        route: 'report_interpretation',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        operatorId: 'op-1',
        userId: 'user-1',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        costUsd: 3,
        durationMs: 50,
        outcome: 'complete',
      },
    ]);
  });

  it('never puts prompt or response text in logs or usage records', async () => {
    const reply = ['空腹血糖偏高', '，建议复查'];
    const { gateway, records, logs } = setup({ chunks: reply });
    await collect(gateway.stream(ctx, request));
    const {
      gateway: failing,
      records: r2,
      logs: l2,
    } = setup({
      chunks: reply,
      failWith: new Error(`upstream echoed: ${PROMPT}`),
    });
    await expect(collect(failing.stream(ctx, request))).rejects.toBeInstanceOf(GatewayError);

    const dump = JSON.stringify([records, logs, r2, l2]);
    for (const secret of [PROMPT, '张某某', '7.8', '健康管理助手', ...reply]) {
      expect(dump).not.toContain(secret);
    }
    expect(logs).toHaveLength(1);
  });

  it('applies per-route provider, model and effort overrides', async () => {
    const { gateway, provider } = setup(
      {},
      {
        OPENAI_MODEL: 'gpt-test',
        LLM_DEFAULT_EFFORT: 'low',
        LLM_ROUTES: JSON.stringify({ report_interpretation: { effort: 'high' } }),
      },
    );
    await collect(gateway.stream(ctx, request));
    await collect(gateway.stream(ctx, { ...request, route: 'chat' }));
    expect(provider.calls.map((c) => c.route)).toEqual([
      { provider: 'openai', model: 'gpt-test', effort: 'high' },
      { provider: 'openai', model: 'gpt-test', effort: 'low' },
    ]);
  });

  it('fails clearly when the configured provider has no key', async () => {
    const { gateway, records } = setup({}, { LLM_DEFAULT_PROVIDER: 'anthropic' });
    await expect(collect(gateway.stream(ctx, request))).rejects.toMatchObject({
      kind: 'not_configured',
    });
    expect(records[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'error',
      errorType: 'not_configured',
    });
  });

  it('classifies provider errors and records them', async () => {
    const rateLimited = Object.assign(new Error('429'), { status: 429 });
    const { gateway, records } = setup({ failWith: rateLimited });
    await expect(collect(gateway.stream(ctx, request))).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'error', errorType: 'rate_limited' });
  });

  it('keeps the provider status and error code, and logs them', async () => {
    const badKey = Object.assign(new Error('Incorrect API key provided: sk-...'), {
      status: 401,
      code: 'invalid_api_key',
    });
    const { gateway, logs } = setup({ failWith: badKey });
    await expect(collect(gateway.stream(ctx, request))).rejects.toMatchObject({
      kind: 'provider_error',
      status: 401,
      code: 'invalid_api_key',
    });
    expect(logs).toContainEqual({
      message: 'llm call failed',
      fields: expect.objectContaining({ status: 401, code: 'invalid_api_key' }) as unknown,
    });
    expect(JSON.stringify(logs)).not.toContain('sk-');
  });

  it('takes the error type from an Anthropic error body', async () => {
    const notFound = Object.assign(new Error(`404 ${PROMPT}`), {
      status: 404,
      error: { type: 'error', error: { type: 'not_found_error', message: PROMPT } },
    });
    const { gateway, logs } = setup({ failWith: notFound });
    await expect(collect(gateway.stream(ctx, request))).rejects.toMatchObject({
      kind: 'provider_error',
      status: 404,
      code: 'not_found_error',
    });
    expect(JSON.stringify(logs)).not.toContain('张某某');
  });

  it('drops an error code that is not a plain identifier', async () => {
    const odd = Object.assign(new Error('x'), { status: 400, code: `bad input: ${PROMPT}` });
    const { gateway, logs } = setup({ failWith: odd });
    const err: unknown = await collect(gateway.stream(ctx, request)).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'provider_error', status: 400 });
    expect((err as GatewayError).code).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain('张某某');
  });

  it('does not keep the provider error, which may echo the prompt', async () => {
    const { gateway } = setup({ failWith: new Error(`upstream echoed: ${PROMPT}`) });
    const err: unknown = await collect(gateway.stream(ctx, request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as Error).cause).toBeUndefined();
    expect(JSON.stringify(err) + String(err)).not.toContain('张某某');
  });

  it('records an aborted call when the consumer stops reading early', async () => {
    const { gateway, records } = setup({ chunks: ['a', 'b', 'c'] });
    for await (const event of gateway.stream(ctx, request)) {
      expect(event.type).toBe('text');
      break;
    }
    expect(records).toEqual([expect.objectContaining({ outcome: 'error', errorType: 'aborted' })]);
  });

  it('does not fail the call when usage recording fails', async () => {
    const provider = new MockProvider();
    const logger = { info: vi.fn(), error: vi.fn() };
    const gateway = new LlmGateway({
      config: loadGatewayConfig({}),
      providers: { openai: provider },
      recordUsage: () => Promise.reject(new Error('db down')),
      logger,
    });
    const result = await gateway.complete(ctx, request);
    expect(result.finishReason).toBe('complete');
    expect(logger.error).toHaveBeenCalledWith('llm usage record failed', {
      route: 'report_interpretation',
    });
  });

  describe('complete()', () => {
    it('joins the streamed text', async () => {
      const { gateway } = setup({ chunks: ['你好', '世界'] });
      expect(await gateway.complete(ctx, request)).toMatchObject({
        text: '你好世界',
        finishReason: 'complete',
      });
    });

    it('returns no text when the model refused', async () => {
      const { gateway, records } = setup({ chunks: ['partial'], finishReason: 'refused' });
      expect(await gateway.complete(ctx, request)).toMatchObject({
        text: '',
        finishReason: 'refused',
      });
      expect(records[0]?.outcome).toBe('refused');
    });
  });
});

describe('LlmGateway.completeStructured', () => {
  const summary = z.object({ professional: z.string(), clientFacing: z.string() });
  const format = { name: 'summary', schema: summary };
  const valid = JSON.stringify({ professional: '专业版', clientFacing: '通俗版' });
  const skillRequest = {
    route: 'skill' as const,
    messages: [{ role: 'user' as const, content: PROMPT }],
  };

  it('sends the JSON schema and returns parsed data', async () => {
    const { gateway, provider } = setup({ chunks: [valid.slice(0, 10), valid.slice(10)] });
    const result = await gateway.completeStructured(ctx, skillRequest, format);
    expect(result).toEqual({
      status: 'ok',
      data: { professional: '专业版', clientFacing: '通俗版' },
      model: 'gpt-6.1-sol',
    });
    const sent = provider.calls[0]?.request.responseFormat;
    expect(sent?.name).toBe('summary');
    expect(sent?.schema).toMatchObject({
      type: 'object',
      required: ['professional', 'clientFacing'],
      additionalProperties: false,
    });
    expect(sent?.schema).not.toHaveProperty('$schema');
  });

  it('retries once when the output does not match, then succeeds', async () => {
    const { gateway, provider, records } = setup([
      { chunks: ['{"professional":"x"}'] },
      { chunks: [valid] },
    ]);
    const result = await gateway.completeStructured(ctx, skillRequest, format);
    expect(result.status).toBe('ok');
    expect(provider.calls).toHaveLength(2);
    // 两次调用都计量
    expect(records).toHaveLength(2);
  });

  it('fails with invalid_output after two bad attempts, without logging the output', async () => {
    const bad = '客户张某某血糖偏高 not json';
    const { gateway, logs } = setup({ chunks: [bad] });
    await expect(gateway.completeStructured(ctx, skillRequest, format)).rejects.toMatchObject({
      kind: 'invalid_output',
    });
    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain('张某某');
    expect(dumped).not.toContain(PROMPT);
    expect(logs.filter((l) => (l as { message: string }).message.includes('invalid'))).toHaveLength(
      2,
    );
  });

  it('treats truncated output as invalid and retries', async () => {
    const { gateway, provider } = setup([
      { chunks: [valid], finishReason: 'truncated' },
      { chunks: [valid] },
    ]);
    const result = await gateway.completeStructured(ctx, skillRequest, format);
    expect(result.status).toBe('ok');
    expect(provider.calls).toHaveLength(2);
  });

  it('returns refused without retrying', async () => {
    const { gateway, provider } = setup({ chunks: [], finishReason: 'refused' });
    const result = await gateway.completeStructured(ctx, skillRequest, format);
    expect(result).toEqual({ status: 'refused', model: 'gpt-6.1-sol' });
    expect(provider.calls).toHaveLength(1);
  });
});
