import {
  createGateway,
  LlmGateway,
  type CallContext,
  type GatewayLogger,
  type Provider,
  type ProviderName,
  type UsageRecord,
} from '@health-buddy/ai-engine';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { CompanionScriptKind, CompanionVoiceSpeed } from '@health-buddy/shared';
import { LLM_PROVIDERS } from '../../ai/gateway.provider.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { recordCompanionUsage } from '../../db/companion-device-auth.js';
import { DB } from '../../db/db.provider.js';
import type { Db } from '../../db/database.js';
import { muxOggOpus } from './ogg.js';
import { oggToDownlinkFrames, UPLINK } from './audio.js';

/** 伴侣设备发起的调用：没有用户，按设备计量（迁移 0026） */
export interface DeviceCallContext extends CallContext {
  operatorId: null;
  userId: null;
  deviceId: string;
}

/** 语速设置对应的合成倍速（Q7：老年客户默认偏慢） */
const SPEED: Record<CompanionVoiceSpeed, number> = { slow: 0.85, medium: 1, fast: 1.15 };
/** 语气说明：平缓、亲切，适合老年人 */
const VOICE_INSTRUCTIONS = '用普通话，语气温和亲切，吐字清楚，像晚辈和长辈说话。';
/** 固定话术合成结果的缓存条数（话术种类 × 版本 × 语速） */
const CACHE_LIMIT = 200;

/**
 * 伴侣的语音识别和合成（M6 规格 3.1）：经大模型网关（speech_to_text、text_to_speech 两个用途），
 * 计量记在设备上。固定话术的合成结果按“种类、版本、语速”缓存在内存里，同一句不重复合成。
 * 音频、识别出的文字、合成的文字都不进日志。
 */
@Injectable()
export class CompanionSpeech {
  private readonly gateway: LlmGateway<DeviceCallContext>;
  private readonly cache = new Map<string, Promise<Uint8Array[]>>();

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) db: Db,
    @Optional() @Inject(LLM_PROVIDERS) providers?: Partial<Record<ProviderName, Provider>>,
  ) {
    const nest = new Logger('CompanionSpeech');
    const logger: GatewayLogger = {
      info: (message, fields) => nest.log(`${message} ${JSON.stringify(fields)}`),
      error: (message, fields) => nest.error(`${message} ${JSON.stringify(fields)}`),
    };
    const options = {
      logger,
      recordUsage: (r: UsageRecord, ctx: DeviceCallContext) =>
        recordCompanionUsage(db, {
          deviceId: ctx.deviceId,
          route: r.route,
          provider: r.provider,
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
          durationMs: r.durationMs,
          outcome: r.outcome,
          errorType: r.errorType ?? null,
        }),
    };
    this.gateway = providers
      ? new LlmGateway<DeviceCallContext>({ ...options, config: config.llm, providers })
      : createGateway<DeviceCallContext>(config.llm, options);
  }

  /** 设备上行的 Opus 帧 → 文字 */
  async transcribe(deviceId: string, frames: Uint8Array[], signal?: AbortSignal): Promise<string> {
    const audio = muxOggOpus(frames, UPLINK);
    const result = await this.gateway.transcribe(
      ctxOf(deviceId),
      { route: 'speech_to_text', audio, mediaType: 'audio/ogg', language: 'zh' },
      signal,
    );
    return result.text.trim();
  }

  /** 文字 → 下行 Opus 帧 */
  async synthesize(
    deviceId: string,
    text: string,
    speed: CompanionVoiceSpeed,
    signal?: AbortSignal,
  ): Promise<Uint8Array[]> {
    const result = await this.gateway.synthesize(
      ctxOf(deviceId),
      {
        route: 'text_to_speech',
        text,
        speed: SPEED[speed],
        instructions: VOICE_INSTRUCTIONS,
      },
      signal,
    );
    return oggToDownlinkFrames(result.audio);
  }

  /** 固定话术：按种类、版本、语速缓存；合成失败不缓存 */
  script(
    deviceId: string,
    script: { kind: CompanionScriptKind; version: number; text: string },
    speed: CompanionVoiceSpeed,
  ): Promise<Uint8Array[]> {
    // 键里带文字的哈希：话术以后加入客户称呼等个性化内容时，不会把别人的语音放给这位客户
    const key = `${script.kind}:${script.version}:${speed}:${createHash('sha256').update(script.text).digest('hex')}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.synthesize(deviceId, script.text, speed);
    this.cache.set(key, pending);
    pending.catch(() => this.cache.delete(key));
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return pending;
  }
}

function ctxOf(deviceId: string): DeviceCallContext {
  return { operatorId: null, userId: null, deviceId };
}
