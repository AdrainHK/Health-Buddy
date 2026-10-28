import type { Logger } from '@nestjs/common';
import {
  deviceMessageSchema,
  type CompanionScriptKind,
  type CompanionVoiceSpeed,
  type ServerDeviceMessage,
} from '@health-buddy/shared';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { DeviceConnection } from '../../db/companion-device-auth.js';
import {
  DEFAULT_ENDPOINT,
  DOWNLINK,
  EndpointDetector,
  OpusDecoder,
  rms,
  UPLINK,
  type EndpointOptions,
} from './audio.js';
import type { DeviceSessionRepository } from './device-session.repository.js';
import type { CompanionSpeech } from './speech.service.js';

export interface VoiceOptions {
  /** 设备连上后多久内要发 hello（xiaozhi 等服务器 hello 10 秒） */
  helloTimeoutMs: number;
  /** 多久没有任何消息就断开（设备下次唤醒时重连） */
  idleTimeoutMs: number;
  /** 下行每帧的发送间隔；测试里设为 0 */
  frameIntervalMs: number;
  /** 下行先连发几帧，给设备留缓冲 */
  prebufferFrames: number;
  /** 会话进行中刷新最后在线时间的间隔 */
  seenIntervalMs: number;
  endpoint: EndpointOptions;
}

export const DEFAULT_VOICE_OPTIONS: VoiceOptions = {
  helloTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  frameIntervalMs: DOWNLINK.frameDurationMs,
  prebufferFrames: 5,
  seenIntervalMs: 60_000,
  endpoint: DEFAULT_ENDPOINT,
};

export type ListenMode = 'auto' | 'manual' | 'realtime';

/**
 * 回复一句话的策略。第 3 步只用固定话术跑通“说话 → 识别 → 回复 → 合成 → 播放”，
 * 第 4 步换成对话（大模型 + 边界规则）。返回要念的固定话术种类。
 */
export type Responder = (input: { deviceId: string; text: string }) => Promise<CompanionScriptKind>;

export const fixedResponder: Responder = () => Promise.resolve('daily_intro');

export interface SessionDeps {
  repo: DeviceSessionRepository;
  speech: CompanionSpeech;
  responder: Responder;
  logger: Logger;
  options: VoiceOptions;
}

interface Listening {
  mode: ListenMode;
  frames: Uint8Array[];
  detector: EndpointDetector;
}

/**
 * 一台设备的一次语音会话（xiaozhi WebSocket 协议 v1，M6 规格 3.1）。
 * 设备唤醒后连上来：hello → listen start → 上行 Opus 帧 → 服务器判断说完（auto）或设备
 * listen stop（manual）→ 识别 → stt → 回复 → tts start / sentence_start / 下行 Opus 帧 / tts stop。
 * 每句话处理前重新确认设备状态：解绑、换客户时断开；暂停、撤回同意时只播暂停话术（规格 2.1、Q5）。
 * 音频和文字都不落盘、不进日志；日志只有会话 id 和事件类型。
 */
export class DeviceSession {
  readonly id = randomUUID();
  private helloDone = false;
  private clientId: string | null = null;
  private voiceSpeed: CompanionVoiceSpeed = 'slow';
  private listening: Listening | null = null;
  private busy = false;
  private speaking: AbortController | null = null;
  private closed = false;
  private readonly decoder = new OpusDecoder(UPLINK.sampleRate);
  private readonly maxFrames: number;
  private helloTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private seenTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly conn: DeviceConnection,
    private readonly deps: SessionDeps,
  ) {
    this.maxFrames = Math.ceil(deps.options.endpoint.maxMs / UPLINK.frameDurationMs);
  }

  get deviceId(): string {
    return this.conn.device_id;
  }

  start(onClose: () => void): void {
    this.helloTimer = setTimeout(() => this.close(), this.deps.options.helloTimeoutMs);
    this.touch();
    this.seenTimer = setInterval(() => {
      this.deps.repo.seen(this.deviceId).catch(() => undefined);
    }, this.deps.options.seenIntervalMs);
    this.ws.on('message', (data, isBinary) => {
      this.touch();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.onAudio(buf);
      else void this.onText(buf.toString('utf8'));
    });
    this.ws.on('close', () => {
      this.cleanup();
      onClose();
    });
    this.ws.on('error', () => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.cleanup();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000);
    }
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.speaking?.abort();
    clearTimeout(this.helloTimer);
    clearTimeout(this.idleTimer);
    clearInterval(this.seenTimer);
    this.decoder.release();
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.deps.options.idleTimeoutMs);
  }

  private send(message: ServerDeviceMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private async onText(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = deviceMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    try {
      if (message.type === 'hello') await this.onHello();
      else if (!this.helloDone) return;
      else if (message.type === 'abort') this.speaking?.abort();
      else if (message.state === 'start') this.onListenStart(message.mode ?? 'auto');
      else if (message.state === 'stop') await this.finishUtterance();
    } catch (err) {
      this.fail('message', err);
    }
  }

  private async onHello(): Promise<void> {
    if (this.helloDone) return;
    this.helloDone = true;
    clearTimeout(this.helloTimer);
    this.send({
      type: 'hello',
      transport: 'websocket',
      session_id: this.id,
      audio_params: {
        format: 'opus',
        sample_rate: DOWNLINK.sampleRate,
        channels: 1,
        frame_duration: DOWNLINK.frameDurationMs,
      },
    });
    const state = await this.deps.repo.state(this.deviceId);
    if (!state?.clientId) {
      this.close();
      return;
    }
    this.clientId = state.clientId;
    this.voiceSpeed = state.voiceSpeed;
    if (state.status === 'paused' || state.status === 'revoked') {
      await this.sayAndClose('paused');
    } else if (this.conn.first_connection) {
      // 第一次连接（激活）时播开场白（规格 2.1 第 4 步、N9）
      await this.say('intro');
    }
  }

  private onListenStart(mode: ListenMode): void {
    if (this.busy) return;
    this.speaking?.abort();
    this.listening = {
      mode,
      frames: [],
      detector: new EndpointDetector(UPLINK.frameDurationMs, this.deps.options.endpoint),
    };
  }

  private onAudio(packet: Buffer): void {
    const l = this.listening;
    if (!l || this.busy) return;
    l.frames.push(packet);
    if (l.mode === 'manual') {
      if (l.frames.length >= this.maxFrames) void this.finishUtterance();
      return;
    }
    // 自动收音：服务器按音量判断说完
    const pcm = this.decoder.decode(packet);
    const state = l.detector.push(pcm ? rms(pcm) : 0);
    if (state === 'done') void this.finishUtterance();
    else if (state === 'no_speech') {
      // 一直没人说话：结束这次会话，设备回到待机，下次唤醒再连
      this.listening = null;
      this.close();
    }
  }

  private async finishUtterance(): Promise<void> {
    const l = this.listening;
    this.listening = null;
    if (!l || this.busy || this.closed) return;
    if (l.frames.length === 0) return;
    this.busy = true;
    try {
      // 每句话前确认设备仍绑定在同一位客户名下
      const state = await this.deps.repo.state(this.deviceId);
      if (!state?.clientId || state.clientId !== this.clientId) {
        this.close();
        return;
      }
      this.voiceSpeed = state.voiceSpeed;
      if (state.status === 'paused' || state.status === 'revoked') {
        await this.sayAndClose('paused');
        return;
      }
      this.deps.repo.seen(this.deviceId).catch(() => undefined);
      let text: string;
      try {
        text = await this.deps.speech.transcribe(this.deviceId, l.frames);
      } catch (err) {
        this.fail('stt', err);
        text = '';
      }
      if (!text) {
        await this.say('asr_retry');
        return;
      }
      this.send({ type: 'stt', session_id: this.id, text });
      const reply = await this.deps.responder({ deviceId: this.deviceId, text });
      await this.say(reply);
    } finally {
      this.busy = false;
    }
  }

  private async sayAndClose(kind: CompanionScriptKind): Promise<void> {
    await this.say(kind);
    this.close();
  }

  /** 念一句固定话术；合成失败时只结束这句（不念别的） */
  private async say(kind: CompanionScriptKind): Promise<void> {
    if (this.closed) return;
    const script = await this.deps.repo.script(this.deviceId, kind);
    if (!script) {
      this.deps.logger.error(`companion script missing ${JSON.stringify({ kind })}`);
      return;
    }
    let frames: Uint8Array[];
    try {
      frames = await this.deps.speech.script(this.deviceId, script, this.voiceSpeed);
    } catch (err) {
      this.fail('tts', err);
      return;
    }
    await this.play(script.text, frames);
  }

  private async play(text: string, frames: Uint8Array[]): Promise<void> {
    if (this.closed) return;
    this.speaking?.abort();
    const controller = new AbortController();
    this.speaking = controller;
    const { frameIntervalMs, prebufferFrames } = this.deps.options;
    this.send({ type: 'tts', session_id: this.id, state: 'start' });
    this.send({ type: 'tts', session_id: this.id, state: 'sentence_start', text });
    for (let i = 0; i < frames.length; i++) {
      if (controller.signal.aborted || this.ws.readyState !== WebSocket.OPEN) break;
      this.ws.send(frames[i]!, { binary: true });
      if (frameIntervalMs > 0 && i >= prebufferFrames) {
        await new Promise((r) => setTimeout(r, frameIntervalMs));
      }
    }
    if (this.speaking === controller) this.speaking = null;
    this.send({ type: 'tts', session_id: this.id, state: 'stop' });
  }

  private fail(stage: string, err: unknown): void {
    const kind =
      err && typeof err === 'object' && 'kind' in err && typeof err.kind === 'string'
        ? err.kind
        : 'error';
    this.deps.logger.error(`companion voice failed ${JSON.stringify({ stage, kind })}`);
  }
}
