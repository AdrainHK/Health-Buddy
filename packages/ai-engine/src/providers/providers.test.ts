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

  function make(final: { stop_reason: string; model?: string }, baseURL?: string) {
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
    return { provider: new AnthropicProvider('unused', client, baseURL), calls };
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

  it('leaves out the fallback beta when going through a relay', async () => {
    const { provider, calls } = make({ stop_reason: 'end_turn' }, 'https://relay.example');
    await collect(provider.stream(request, route));
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' } });
    expect(calls[0]).not.toHaveProperty('betas');
    expect(calls[0]).not.toHaveProperty('fallbacks');
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

describe('structured output', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const structured: GatewayRequest = { ...request, responseFormat: { name: 'demo', schema } };

  it('OpenAI uses a strict json_schema text format', async () => {
    const calls: unknown[] = [];
    const client = {
      responses: {
        stream: (params: unknown) => {
          calls.push(params);
          return fakeStream([], 'finalResponse', {
            model: 'gpt-6-astra',
            status: 'completed',
            incomplete_details: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    } as unknown as OpenAI;
    await collect(
      new OpenAIProvider('unused', client).stream(structured, {
        provider: 'openai',
        model: 'gpt-6-astra',
        effort: 'medium',
      }),
    );
    expect(calls[0]).toMatchObject({
      text: { format: { type: 'json_schema', name: 'demo', schema, strict: true } },
    });
  });

  it('Claude uses output_config.format alongside effort', async () => {
    const calls: unknown[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            calls.push(params);
            return fakeStream([], 'finalMessage', {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
        },
      },
    } as unknown as Anthropic;
    await collect(
      new AnthropicProvider('unused', client).stream(structured, {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        effort: 'high',
      }),
    );
    expect(calls[0]).toMatchObject({
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    });
  });

  it('plain requests send no format', async () => {
    const calls: unknown[] = [];
    const client = {
      responses: {
        stream: (params: unknown) => {
          calls.push(params);
          return fakeStream([], 'finalResponse', {
            model: 'gpt-6-astra',
            status: 'completed',
            incomplete_details: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    } as unknown as OpenAI;
    await collect(
      new OpenAIProvider('unused', client).stream(request, {
        provider: 'openai',
        model: 'gpt-6-astra',
        effort: 'medium',
      }),
    );
    expect(calls[0]).not.toHaveProperty('text');
  });
});

describe('image and PDF input (M2 report extraction)', () => {
  const multimodal: GatewayRequest = {
    route: 'report_extraction',
    system: 'system prompt',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'page 1 of 2' },
          { type: 'image', mediaType: 'image/png', data: 'aW1n' },
          { type: 'pdf', data: 'cGRm' },
        ],
      },
    ],
  };

  it('OpenAI sends input_text, input_image and input_file with a neutral file name', async () => {
    const calls: unknown[] = [];
    const client = {
      responses: {
        stream: (params: unknown) => {
          calls.push(params);
          return fakeStream([], 'finalResponse', {
            model: 'gpt-6-astra',
            status: 'completed',
            incomplete_details: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    } as unknown as OpenAI;
    await collect(
      new OpenAIProvider('unused', client).stream(multimodal, {
        provider: 'openai',
        model: 'gpt-6-astra',
        effort: 'medium',
      }),
    );
    expect(calls[0]).toMatchObject({
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'page 1 of 2' },
            { type: 'input_image', image_url: 'data:image/png;base64,aW1n', detail: 'high' },
            {
              type: 'input_file',
              filename: 'document.pdf',
              file_data: 'data:application/pdf;base64,cGRm',
            },
          ],
        },
      ],
    });
  });

  it('Claude sends image and document blocks', async () => {
    const calls: unknown[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            calls.push(params);
            return fakeStream([], 'finalMessage', {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
        },
      },
    } as unknown as Anthropic;
    await collect(
      new AnthropicProvider('unused', client).stream(multimodal, {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        effort: 'high',
      }),
    );
    expect(calls[0]).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'page 1 of 2' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
            },
          ],
        },
      ],
    });
  });
});

describe('OpenAIProvider speech', () => {
  const route: ResolvedRoute = { provider: 'openai', model: 'gpt-4o-mini-tts', effort: 'low' };

  it('asks for Opus output with the default voice', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      audio: {
        speech: {
          create: (params: Record<string, unknown>) => {
            calls.push(params);
            return Promise.resolve(new Response(new Uint8Array([1, 2])));
          },
        },
      },
    } as unknown as OpenAI;
    const result = await new OpenAIProvider('unused', client).synthesize(
      { route: 'text_to_speech', text: '你好', speed: 0.9 },
      route,
    );
    expect([...result.audio]).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({
      model: 'gpt-4o-mini-tts',
      input: '你好',
      response_format: 'opus',
      speed: 0.9,
      voice: 'coral',
    });
  });

  it('transcribes with token usage', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      audio: {
        transcriptions: {
          create: (params: Record<string, unknown>) => {
            calls.push(params);
            return Promise.resolve({
              text: '你好',
              usage: { type: 'tokens', input_tokens: 30, output_tokens: 2 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const result = await new OpenAIProvider('unused', client).transcribe(
      {
        route: 'speech_to_text',
        audio: new Uint8Array([1]),
        mediaType: 'audio/ogg',
        language: 'zh',
      },
      { ...route, model: 'gpt-4o-mini-transcribe' },
    );
    expect(result).toEqual({
      text: '你好',
      usage: { inputTokens: 30, outputTokens: 2 },
      model: 'gpt-4o-mini-transcribe',
    });
    expect(calls[0]).toMatchObject({ language: 'zh', response_format: 'json' });
    expect((calls[0]!.file as File).name).toBe('speech.ogg');
  });
});
