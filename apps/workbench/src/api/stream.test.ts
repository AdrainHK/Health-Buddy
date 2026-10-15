import type { TaskStreamEvent } from '@health-buddy/shared';
import { controlledSse, ids, json, mockApi, sseResponse } from '../test/mockApi';
import { ApiError } from './http';
import { SseParser, parseStreamEvent, streamRequest } from './stream';

const text = (delta: string): TaskStreamEvent => ({
  type: 'text',
  messageId: ids.assistantMsg,
  delta,
});
const done: TaskStreamEvent = { type: 'done', messageId: ids.assistantMsg, reason: 'complete' };

describe('SseParser', () => {
  it('splits events on blank lines and keeps partial events for the next chunk', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}']);
    expect(parser.push('ta: {"b":2}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual(['{"b":2}']);
  });

  it('joins multi-line data, ignores comments and other fields, handles CRLF', () => {
    const parser = new SseParser();
    expect(
      parser.push(': keep-alive\n\nevent: x\nid: 1\ndata: line1\r\ndata:line2\r\n\r\n'),
    ).toEqual(['line1\nline2']);
  });

  it('does not split a CRLF that arrives across two chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual(['x']);
  });

  it('flushes a trailing event without a blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: tail')).toEqual([]);
    expect(parser.flush()).toEqual(['tail']);
  });
});

describe('parseStreamEvent', () => {
  it('validates with taskStreamEventSchema', () => {
    expect(parseStreamEvent(JSON.stringify(text('你好')))).toEqual(text('你好'));
    expect(parseStreamEvent('{"type":"text","messageId":"not-a-uuid","delta":"x"}')).toBe(
      undefined,
    );
    expect(parseStreamEvent('{"type":"unknown"}')).toBe(undefined);
    expect(parseStreamEvent('not json')).toBe(undefined);
  });
});

describe('streamRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the body and emits validated events in order, skipping invalid ones', async () => {
    const api = mockApi({
      'POST /tasks/x/messages': () =>
        sseResponse([
          text('一'),
          { type: 'text', messageId: 'bad', delta: '坏' },
          text('二'),
          done,
        ]),
    });
    const events: TaskStreamEvent[] = [];
    const onOpen = vi.fn();
    await streamRequest('/tasks/x/messages', {
      body: { mode: 'ask', content: '合成问题' },
      onOpen,
      onEvent: (e) => events.push(e),
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(events).toEqual([text('一'), text('二'), done]);
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      body: { mode: 'ask', content: '合成问题' },
    });
  });

  it('handles events split across network chunks', async () => {
    let sse!: ReturnType<typeof controlledSse>;
    mockApi({
      'POST /s': () => {
        sse = controlledSse();
        return sse.response;
      },
    });
    const events: TaskStreamEvent[] = [];
    const pending = streamRequest('/s', { onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(sse).toBeDefined());
    const frame = `data: ${JSON.stringify(text('分块'))}\n\n`;
    sse.raw(frame.slice(0, 10));
    sse.raw(frame.slice(10));
    sse.close();
    await pending;
    expect(events).toEqual([text('分块')]);
  });

  it('throws ApiError with the structured reasons before the stream opens', async () => {
    mockApi({ 'POST /s': () => json(409, { error: 'conflict', reasons: ['busy'] }) });
    const onOpen = vi.fn();
    const err = await streamRequest('/s', { onOpen, onEvent: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'conflict', status: 409, reasons: ['busy'] });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('throws ApiError(too_many_requests) on 429', async () => {
    mockApi({ 'POST /s': () => json(429, { error: 'too_many_requests' }) });
    await expect(streamRequest('/s', { onEvent: () => {} })).rejects.toMatchObject({
      code: 'too_many_requests',
      status: 429,
    });
  });

  it('rejects with AbortError when aborted mid-stream', async () => {
    const controller = new AbortController();
    let sse!: ReturnType<typeof controlledSse>;
    mockApi({
      'POST /s': (_call, init) => {
        sse = controlledSse(init?.signal);
        return sse.response;
      },
    });
    const events: TaskStreamEvent[] = [];
    const pending = streamRequest('/s', {
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    await vi.waitFor(() => expect(sse).toBeDefined());
    sse.send(text('前半'));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a dropped connection as a network error', async () => {
    mockApi({
      'POST /s': () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new TypeError('connection reset'));
            },
          }),
          { status: 200 },
        ),
    });
    await expect(streamRequest('/s', { onEvent: () => {} })).rejects.toMatchObject({
      code: 'network',
    });
  });
});
