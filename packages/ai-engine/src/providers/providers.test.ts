import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { GatewayEvent, GatewayRequest, ResolvedRoute } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

const request: GatewayRequest = {
  route: 'chat',
  system: 'system prompt',
  messages: [{ role: 'user', content: 'hi' }],
};

async function collect(stream: AsyncIterable<GatewayEvent>) {
  const events: GatewayEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** 造一个“既能 for await 又有 final 方法”的假流，形状和 SDK 返回的流一致。 */
function fakeStream<T>(events: unknown[], finalKey: string, final: T) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    [finalKey]: () => Promise.resolve(final),
  };
}

describe('AnthropicProvider', () => {
  const route: ResolvedRoute = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' };

  function make(final: { stop_reason: string; model?: string }) {
    const calls: unknown[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            calls.push(params);
            return fakeStream(
              [
                {
                  type: 'content_block_delta',
                  delta: { type: 'thinking_delta', thinking: 'hidden' },
                },
                { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
              ],
              'finalMessage',
              {
                model: final.model ?? 'claude-opus-5-5',
                stop_reason: final.stop_reason,
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 5,
                  cache_read_input_tokens: 2,
                  output_tokens: 7,
                },
              },
            );
          },
        },
      },
    } as unknown as Anthropic;
    return { provider: new AnthropicProvider('unused', client), calls };
  }

  it('uses adaptive thinking, effort and server-side fallback', async () => {
    const { provider, calls } = make({ stop_reason: 'end_turn' });
    const events = await collect(provider.stream(request, route));
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // 思考内容不会传给业务层
    expect(events).toEqual([
      { type: 'text', delta: 'Hello' },
      {
        type: 'done',
        finishReason: 'complete',
        usage: { inputTokens: 17, outputTokens: 7 },
        model: 'claude-opus-5-5',
      },
    ]);
  });

  it('maps refusal and max_tokens', async () => {
    const refused = await collect(make({ stop_reason: 'refusal' }).provider.stream(request, route));
    expect(refused.at(-1)).toMatchObject({ finishReason: 'refused' });
    const truncated = await collect(
      make({ stop_reason: 'max_tokens' }).provider.stream(request, route),
    );
    expect(truncated.at(-1)).toMatchObject({ finishReason: 'truncated' });
  });

  it('reports the model that actually served the turn', async () => {
    const events = await collect(
      make({ stop_reason: 'end_turn', model: 'claude-opus-4-8' }).provider.stream(request, route),
    );
    expect(events.at(-1)).toMatchObject({ model: 'claude-opus-4-8' });
  });
});

describe('OpenAIProvider', () => {
  const route: ResolvedRoute = { provider: 'openai', model: 'gpt-5', effort: 'low' };

  function make(events: unknown[], final: Record<string, unknown>) {
    const calls: unknown[] = [];
    const client = {
      responses: {
        stream: (params: unknown) => {
          calls.push(params);
          return fakeStream(events, 'finalResponse', {
            model: 'gpt-5',
            status: 'completed',
            incomplete_details: null,
            usage: { input_tokens: 11, output_tokens: 4 },
            ...final,
          });
        },
      },
    } as unknown as OpenAI;
    return { provider: new OpenAIProvider('unused', client), calls };
  }

  it('streams text and does not ask OpenAI to store the conversation', async () => {
    const { provider, calls } = make(
      [
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
      ],
      {},
    );
    const events = await collect(provider.stream(request, route));
    expect(calls[0]).toMatchObject({
      model: 'gpt-5',
      store: false,
      reasoning: { effort: 'low' },
      instructions: 'system prompt',
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(events).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      {
        type: 'done',
        finishReason: 'complete',
        usage: { inputTokens: 11, outputTokens: 4 },
        model: 'gpt-5',
      },
    ]);
  });

  it('turns refusals and content filtering into refused', async () => {
    const refused = await collect(
      make([{ type: 'response.refusal.delta', delta: 'I cannot' }], {}).provider.stream(
        request,
        route,
      ),
    );
    expect(refused).toEqual([expect.objectContaining({ type: 'done', finishReason: 'refused' })]);
    const filtered = await collect(
      make([], {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }).provider.stream(request, route),
    );
    expect(filtered.at(-1)).toMatchObject({ finishReason: 'refused' });
  });

  it('maps max_output_tokens to truncated', async () => {
    const events = await collect(
      make([], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }).provider.stream(request, route),
    );
    expect(events.at(-1)).toMatchObject({ finishReason: 'truncated' });
  });
});
