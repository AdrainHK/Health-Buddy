import OpusScript from 'opusscript';
import { demuxOggOpus } from './ogg.js';

/**
 * 语音通道的音频参数和处理（M6 规格 3.1）。和 xiaozhi 固件的约定：
 * - 设备上行：Opus，16 kHz，单声道，每帧 60 ms；
 * - 下行（福宝说话）：Opus，24 kHz，单声道，每帧 60 ms，在服务器的 hello 里告诉设备。
 * 音频只在内存里处理，不落盘、不进日志。
 */
export const UPLINK = { sampleRate: 16000, frameDurationMs: 60 } as const;
export const DOWNLINK = { sampleRate: 24000, frameDurationMs: 60 } as const;

type Rate = 8000 | 12000 | 16000 | 24000 | 48000;

function samplesPerFrame(rate: number, frameMs: number): number {
  return Math.round((rate * frameMs) / 1000);
}

/** Opus 解码器（每个会话一个，用完 release） */
export class OpusDecoder {
  private codec: OpusScript | null;

  constructor(rate: Rate) {
    this.codec = new OpusScript(rate, 1, OpusScript.Application.VOIP);
  }

  /** 解码一帧，返回 16 位 PCM；坏帧返回 undefined */
  decode(packet: Uint8Array): Int16Array | undefined {
    if (!this.codec) return undefined;
    try {
      const pcm = this.codec.decode(Buffer.from(packet));
      return new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1).slice();
    } catch {
      return undefined;
    }
  }

  release(): void {
    this.codec?.delete();
    this.codec = null;
  }
}

/** 16 位 PCM 编码成固定时长的 Opus 帧；最后不足一帧的补静音 */
export function encodePcm(pcm: Int16Array, rate: Rate, frameMs: number): Uint8Array[] {
  const frame = samplesPerFrame(rate, frameMs);
  const encoder = new OpusScript(rate, 1, OpusScript.Application.VOIP);
  try {
    const packets: Uint8Array[] = [];
    for (let i = 0; i < pcm.length; i += frame) {
      const chunk = new Int16Array(frame);
      chunk.set(pcm.subarray(i, Math.min(i + frame, pcm.length)));
      const encoded = encoder.encode(Buffer.from(chunk.buffer), frame);
      packets.push(Uint8Array.from(encoded));
    }
    return packets;
  } finally {
    encoder.delete();
  }
}

/**
 * 语音合成返回的 Ogg Opus → 设备要的 24 kHz、60 ms 帧。
 * 厂商的帧长不一定是 60 ms，解码后重新编码，保证和 hello 里告诉设备的参数一致。
 */
export function oggToDownlinkFrames(ogg: Uint8Array): Uint8Array[] {
  const decoder = new OpusDecoder(DOWNLINK.sampleRate);
  try {
    const parts: Int16Array[] = [];
    for (const packet of demuxOggOpus(ogg)) {
      const pcm = decoder.decode(packet);
      if (pcm) parts.push(pcm);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const p of parts) {
      pcm.set(p, offset);
      offset += p.length;
    }
    return encodePcm(pcm, DOWNLINK.sampleRate, DOWNLINK.frameDurationMs);
  } finally {
    decoder.release();
  }
}

/** 均方根音量（0–32767） */
export function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
}

export interface EndpointOptions {
  /** 音量超过这个值算有声音 */
  speechRms: number;
  /** 说话后连续静音这么久算说完 */
  silenceMs: number;
  /** 一句话最长 */
  maxMs: number;
  /** 开始收音后这么久还没说话，算没说话 */
  noSpeechMs: number;
}

export const DEFAULT_ENDPOINT: EndpointOptions = {
  speechRms: 500,
  silenceMs: 800,
  maxMs: 30_000,
  noSpeechMs: 8_000,
};

export type EndpointState = 'listening' | 'speaking' | 'done' | 'no_speech';

/**
 * 简单的端点检测（自动收音模式）：按每帧音量判断说话开始和结束。
 * 设备在 auto 模式下不自己判断说完，由服务器判断后回复（xiaozhi 协议）。
 */
export class EndpointDetector {
  private elapsedMs = 0;
  private silentMs = 0;
  private heardSpeech = false;

  constructor(
    private readonly frameMs: number,
    private readonly options: EndpointOptions = DEFAULT_ENDPOINT,
  ) {}

  get hasSpeech(): boolean {
    return this.heardSpeech;
  }

  /** 送入一帧的音量，返回当前状态 */
  push(level: number): EndpointState {
    this.elapsedMs += this.frameMs;
    if (level >= this.options.speechRms) {
      this.heardSpeech = true;
      this.silentMs = 0;
    } else {
      this.silentMs += this.frameMs;
    }
    if (this.heardSpeech) {
      if (this.silentMs >= this.options.silenceMs || this.elapsedMs >= this.options.maxMs) {
        return 'done';
      }
      return 'speaking';
    }
    if (this.elapsedMs >= this.options.noSpeechMs) return 'no_speech';
    return 'listening';
  }
}
