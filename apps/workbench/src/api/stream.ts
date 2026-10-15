import {
  taskStreamEventSchema,
  type SendMessageRequest,
  type TaskStreamEvent,
} from '@health-buddy/shared';
import { ApiError, apiFetch, toApiError } from './http';

/**
 * 解析 text/event-stream：按空行切分事件，取每个事件里 `data:` 行的内容
 * （多行 data 按规范用换行拼接）。不完整的尾部留到下一块再处理。
 */
export class SseParser {
  private buffer = '';

  /** 喂入一段文本，返回其中已完整的事件的 data 内容 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    // 统一换行符；末尾单独的 \r 可能是 \r\n 的前半，留到下一块
    const keepCr = this.buffer.endsWith('\r');
    const text = (keepCr ? this.buffer.slice(0, -1) : this.buffer).replace(/\r\n?/g, '\n');
    const out: string[] = [];
    let rest = text;
    let end = rest.indexOf('\n\n');
    while (end !== -1) {
      const data = parseBlock(rest.slice(0, end));
      if (data !== undefined) out.push(data);
      rest = rest.slice(end + 2);
      end = rest.indexOf('\n\n');
    }
    this.buffer = keepCr ? `${rest}\r` : rest;
    return out;
  }

  /** 流结束时调用：处理最后一个没有以空行结尾的事件 */
  flush(): string[] {
    const tail = this.buffer;
    this.buffer = '';
    return this.push(`${tail}\n\n`);
  }
}

function parseBlock(block: string): string | undefined {
  const lines: string[] = [];
  for (const line of block.split('\n')) {
    // 注释（以 : 开头）以及 event、id 等字段目前用不到
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    lines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** 把一条 data 按 taskStreamEventSchema 校验；格式不对或不认识的事件返回 undefined */
export function parseStreamEvent(data: string): TaskStreamEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = taskStreamEventSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export interface StreamOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** 服务端接受请求、开始推送时调用（之后的失败不再是“请求被拒绝”） */
  onOpen?: () => void;
  onEvent: (event: TaskStreamEvent) => void;
}

/**
 * POST 一个返回 SSE 的接口，逐个回调校验过的事件，流结束时返回。
 * - 打开流之前的错误（400、404、409、429 等）抛出 ApiError；
 * - 读流中途断网抛出 ApiError('network')；
 * - 通过 signal 取消时抛出 AbortError。
 * 校验不通过的事件直接丢弃，不中断整个流。
 */
export async function streamRequest(path: string, options: StreamOptions): Promise<void> {
  const res = await apiFetch(path, {
    method: 'POST',
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  options.onOpen?.();
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const emit = (payloads: string[]) => {
    for (const data of payloads) {
      const event = parseStreamEvent(data);
      if (event) options.onEvent(event);
    }
  };
  try {
    for (;;) {
      if (options.signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
    emit(parser.push(decoder.decode()));
    emit(parser.flush());
  } catch (err) {
    if (options.signal?.aborted) throw abortError();
    if (err instanceof ApiError) throw err;
    throw new ApiError('network', 0);
  } finally {
    reader.releaseLock();
  }
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** POST /api/tasks/:id/messages */
export function sendMessage(
  taskId: string,
  body: SendMessageRequest,
  options: Omit<StreamOptions, 'body'>,
): Promise<void> {
  return streamRequest(`/tasks/${taskId}/messages`, { ...options, body });
}

/** POST /api/tasks/:id/plans/:planId/confirm */
export function confirmPlan(
  taskId: string,
  planId: string,
  options: Omit<StreamOptions, 'body'>,
): Promise<void> {
  return streamRequest(`/tasks/${taskId}/plans/${planId}/confirm`, options);
}
