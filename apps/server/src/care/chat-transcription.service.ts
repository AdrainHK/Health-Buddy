import { Inject, Injectable, Logger } from '@nestjs/common';
import { GatewayError } from '@health-buddy/ai-engine';
import type { ChatTranscriptionFailure } from '@health-buddy/shared';
import {
  CHAT_TRANSCRIPTION_FORMAT_NAME,
  CHAT_TRANSCRIPTION_PROMPT,
  buildChatTranscriptionContent,
  chatTranscriptionOutputSchema,
  redactAddresses,
  redactIdentifiers,
  renderChatTranscript,
  type ChatScreenshotInput,
} from '@health-buddy/skills';
import { LLM_GATEWAY, type AppGateway } from '../ai/gateway.provider.js';
import type { TenantContext } from '../db/database.js';
import { heicToJpeg, sniffMimeType } from '../reports/file-inspect.js';

/** 一次转写的超时（9 张图一次调用） */
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 8_000;

export class TranscriptionFailure extends Error {
  constructor(readonly reason: ChatTranscriptionFailure) {
    super(`chat transcription failed: ${reason}`);
    this.name = 'TranscriptionFailure';
  }
}

/** 文件不是支持的图片（只收 PNG、JPEG、HEIC，不收 PDF） */
export class UnsupportedScreenshot extends Error {
  constructor() {
    super('unsupported screenshot');
    this.name = 'UnsupportedScreenshot';
  }
}

/**
 * 聊天截图转写（M5 规格 2.9“聊天截图”）：截图只在这次调用的内存里用，转写完即丢弃，
 * 不进对象存储、日志和错误信息；返回的文字不保存，健管师核对后再作为素材上传。
 * 日志只有张数、结果类别和耗时。
 */
@Injectable()
export class ChatTranscriptionService {
  private readonly logger = new Logger(ChatTranscriptionService.name);

  constructor(@Inject(LLM_GATEWAY) private readonly gateway: AppGateway) {}

  /** 按文件头判断类型并转成模型能收的格式；有一张不支持就整体拒绝 */
  async prepare(buffers: readonly Buffer[]): Promise<ChatScreenshotInput[]> {
    const out: ChatScreenshotInput[] = [];
    for (const buf of buffers) {
      const mime = buf.length ? sniffMimeType(buf) : null;
      if (mime === 'image/png' || mime === 'image/jpeg') {
        out.push({ mediaType: mime, base64: buf.toString('base64') });
      } else if (mime === 'image/heic') {
        let jpeg: Buffer;
        try {
          jpeg = await heicToJpeg(buf);
        } catch {
          throw new UnsupportedScreenshot();
        }
        out.push({ mediaType: 'image/jpeg', base64: jpeg.toString('base64') });
      } else {
        throw new UnsupportedScreenshot();
      }
    }
    return out;
  }

  /** 转写成素材文字；电话、证件号、地址按格式再去掉一遍 */
  async transcribe(ctx: TenantContext, images: readonly ChatScreenshotInput[]): Promise<string> {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const result = await this.gateway.completeStructured(
        ctx,
        {
          route: 'report_extraction',
          system: CHAT_TRANSCRIPTION_PROMPT,
          messages: [{ role: 'user', content: buildChatTranscriptionContent(images) }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
        { name: CHAT_TRANSCRIPTION_FORMAT_NAME, schema: chatTranscriptionOutputSchema },
        controller.signal,
      );
      if (result.status === 'refused') throw new TranscriptionFailure('refused');
      const output = result.data;
      if (output.category !== 'chat') throw new TranscriptionFailure(output.category);
      const text = redactAddresses(redactIdentifiers(renderChatTranscript(output))).trim();
      if (!text) throw new TranscriptionFailure('unreadable');
      this.log(images.length, 'done', started);
      return text;
    } catch (err) {
      const reason: ChatTranscriptionFailure =
        err instanceof TranscriptionFailure ? err.reason : timedOut ? 'timeout' : 'error';
      // 只记类别和网关的错误种类、状态码，不记截图和文字
      const detail =
        err instanceof GatewayError ? `:${err.kind}${err.status ? `:${err.status}` : ''}` : '';
      this.log(images.length, `failed:${reason}${detail}`, started);
      throw err instanceof TranscriptionFailure ? err : new TranscriptionFailure(reason);
    } finally {
      clearTimeout(timer);
    }
  }

  private log(images: number, outcome: string, started: number): void {
    this.logger.log(
      `chat transcription ${JSON.stringify({ images, outcome, durationMs: Date.now() - started })}`,
    );
  }
}
