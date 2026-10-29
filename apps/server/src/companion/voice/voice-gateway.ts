import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DeviceAuthService } from '../device-auth.service.js';
import { DEVICE_WS_PATH } from '../device-ota.controller.js';
import { DeviceSessionRepository } from './device-session.repository.js';
import { DEFAULT_VOICE_OPTIONS, DeviceSession, type VoiceOptions } from './device-session.js';
import { CompanionDialogue } from './dialogue.service.js';
import { CompanionSpeech } from './speech.service.js';

/** 测试用：替换语音会话的时间参数（帧间隔、超时、端点检测） */
export const VOICE_OPTIONS = Symbol('VOICE_OPTIONS');

/** 一帧最大 64 KB（Opus 帧和控制消息都远小于这个） */
const MAX_PAYLOAD = 64 * 1024;

/**
 * 伴侣设备的语音通道 /ws/device（M6 规格 3.1）。挂在 HTTP 服务器的 upgrade 上：
 * 只认 Authorization: Bearer <设备令牌>，工作台的会话 Cookie 不起作用（规格 6.4）。
 * 令牌无效、已作废、设备解绑后返回 401；同一台设备只保留最新的一个连接。
 */
@Injectable()
export class VoiceGateway implements OnModuleDestroy {
  private readonly logger = new Logger('CompanionVoice');
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly options: VoiceOptions;

  constructor(
    private readonly auth: DeviceAuthService,
    private readonly repo: DeviceSessionRepository,
    private readonly speech: CompanionSpeech,
    private readonly dialogue: CompanionDialogue,
    @Optional() @Inject(VOICE_OPTIONS) options?: Partial<VoiceOptions>,
  ) {
    this.options = { ...DEFAULT_VOICE_OPTIONS, ...options };
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.upgrade(req, socket, head);
    });
  }

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.wss.close();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== DEVICE_WS_PATH) {
      reject(socket, 404, 'Not Found');
      return;
    }
    // 只支持协议 v1（二进制帧是裸 Opus）
    const version = req.headers['protocol-version'];
    if (version !== undefined && version !== '1') {
      reject(socket, 400, 'Bad Request');
      return;
    }
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    let conn;
    try {
      conn = token ? await this.auth.connect(token) : undefined;
    } catch {
      this.logger.error('companion device connect failed');
      reject(socket, 503, 'Service Unavailable');
      return;
    }
    if (!conn) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.sessions.get(conn.device_id)?.close();
      const session = new DeviceSession(ws, conn, {
        repo: this.repo,
        speech: this.speech,
        dialogue: this.dialogue,
        logger: this.logger,
        options: this.options,
      });
      this.sessions.set(conn.device_id, session);
      session.start(() => {
        if (this.sessions.get(conn.device_id) === session) this.sessions.delete(conn.device_id);
      });
    });
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}
