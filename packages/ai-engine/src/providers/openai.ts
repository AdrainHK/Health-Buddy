import OpenAI from 'openai';
import type {
  ChatMessage,
  ContentPart,
  GatewayEvent,
  GatewayRequest,
  Provider,
  ResolvedRoute,
} from '../types.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

/** ChatGPT 适配器，使用 Responses API 流式输出。 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey });
  }

  async *stream(
    request: GatewayRequest,
    route: ResolvedRoute,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayEvent> {
    const stream = this.client.responses.stream(
      {
        model: route.model,
        max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        reasoning: { effort: route.effort },
        // 不让 OpenAI 保存对话内容
        store: false,
        ...(request.system ? { instructions: request.system } : {}),
        input: request.messages.map(toInputMessage),
        ...(request.responseFormat
          ? {
              text: {
                format: {
                  type: 'json_schema' as const,
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: true,
                },
              },
            }
          : {}),
      },
      signal ? { signal } : undefined,
    );

    let refused = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield { type: 'text', delta: event.delta };
      } else if (event.type === 'response.refusal.delta') {
        // 拒答文本不转给业务层，统一成 refused
        refused = true;
      }
    }

    const response = await stream.finalResponse();
    const truncated =
      response.status === 'incomplete' &&
      response.incomplete_details?.reason === 'max_output_tokens';
    const contentFiltered =
      response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter';
    yield {
      type: 'done',
      finishReason: refused || contentFiltered ? 'refused' : truncated ? 'truncated' : 'complete',
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      model: response.model,
    };
  }
}

/**
 * 统一消息转成 Responses API 的输入。图片用 data URL 的 input_image，PDF 用 input_file；
 * PDF 的文件名是固定的占位名，不用原文件名（可能含客户姓名）。
 * assistant 消息只能是文字，多段时拼起来。
 */
function toInputMessage(m: ChatMessage) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  if (m.role === 'assistant') return { role: m.role, content: textOf(m.content) };
  return {
    role: m.role,
    content: m.content.map((part) => {
      switch (part.type) {
        case 'text':
          return { type: 'input_text' as const, text: part.text };
        case 'image':
          return {
            type: 'input_image' as const,
            image_url: `data:${part.mediaType};base64,${part.data}`,
            detail: 'high' as const,
          };
        case 'pdf':
          return {
            type: 'input_file' as const,
            filename: 'document.pdf',
            file_data: `data:application/pdf;base64,${part.data}`,
          };
      }
    }),
  };
}

function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}
