import { z } from 'zod';

/**
 * 伴侣设备“福宝”和服务器之间的约定（M6 规格 3.1、3.2）。固件基于 xiaozhi-esp32（N1），
 * 按它的 WebSocket 协议（v1：二进制帧是裸 Opus）和 OTA 激活 v2。
 * 这里只列服务器认的消息；设备发来的其他类型（如 mcp）忽略。
 */

/** 设备激活请求：hmac = hex(HMAC-SHA256(eFuse key0, challenge)) */
export const deviceActivateRequestSchema = z.object({
  algorithm: z.literal('hmac-sha256'),
  serial_number: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/),
  challenge: z.string().regex(/^[0-9a-f]{64}$/),
  hmac: z.string().regex(/^[0-9a-fA-F]{64}$/),
});
export type DeviceActivateRequest = z.infer<typeof deviceActivateRequestSchema>;

/** 配置接口的响应（服务器给的字段） */
export interface DeviceOtaResponse {
  server_time: { timestamp: number; timezone_offset: number };
  activation?: { message: string; challenge: string; timeout_ms: number };
  websocket?: { url: string; token: string; version: number };
}

const audioParamsSchema = z.object({
  format: z.literal('opus'),
  sample_rate: z.number().int(),
  channels: z.number().int(),
  frame_duration: z.number().int(),
});

export const deviceHelloSchema = z.object({
  type: z.literal('hello'),
  version: z.number().int().optional(),
  transport: z.literal('websocket'),
  audio_params: audioParamsSchema.partial().optional(),
});

export const deviceListenSchema = z.object({
  type: z.literal('listen'),
  session_id: z.string().optional(),
  state: z.enum(['start', 'stop', 'detect']),
  mode: z.enum(['auto', 'manual', 'realtime']).optional(),
  /** 唤醒词（state 为 detect 时），服务器不使用 */
  text: z.string().max(100).optional(),
});

export const deviceAbortSchema = z.object({
  type: z.literal('abort'),
  session_id: z.string().optional(),
  reason: z.string().max(50).optional(),
});

export const deviceMessageSchema = z.discriminatedUnion('type', [
  deviceHelloSchema,
  deviceListenSchema,
  deviceAbortSchema,
]);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

/** 服务器发给设备的消息 */
export type ServerDeviceMessage =
  | {
      type: 'hello';
      transport: 'websocket';
      session_id: string;
      audio_params: z.infer<typeof audioParamsSchema>;
    }
  | { type: 'stt'; session_id: string; text: string }
  | { type: 'tts'; session_id: string; state: 'start' | 'stop' }
  | { type: 'tts'; session_id: string; state: 'sentence_start'; text: string }
  | { type: 'llm'; session_id: string; emotion: string };
