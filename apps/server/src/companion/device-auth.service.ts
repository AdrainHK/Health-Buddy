import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeviceOtaResponse } from '@health-buddy/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import {
  activateDeviceToken,
  connectDevice,
  deviceAuthLookup,
  issueDeviceToken,
  type DeviceConnection,
} from '../db/companion-device-auth.js';
import { DB } from '../db/db.provider.js';
import type { Db } from '../db/database.js';
import {
  BindAttemptLimiter,
  DeviceSecretCipher,
  hashDeviceToken,
  newChallenge,
  newDeviceToken,
  verifyDeviceHmac,
} from './device-credentials.js';

/** 设备令牌有效期（规格 3.2；设备每次开机请求配置接口时换新） */
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 设备算 HMAC、回传激活请求的等待时间（xiaozhi 的 activation.timeout_ms） */
const ACTIVATION_TIMEOUT_MS = 30_000;
/** 设备时区：服务在中国大陆，固定东八区（分钟） */
const TIMEZONE_OFFSET_MINUTES = 480;

export type ActivateResult = 'ok' | 'unauthorized' | 'limited';

/**
 * 伴侣设备的认证（M6 规格 3.2）：xiaozhi 激活 v2。
 * 1. 设备开机请求配置接口，带 Serial-Number 头。设备已绑定时，服务器发一个随机挑战和一个待验证的
 *    令牌（连同 WebSocket 地址）；未绑定、序列号不存在时不发令牌，也不透露是哪种情况。
 * 2. 设备用 eFuse 里的密钥算 HMAC-SHA256(挑战) 回传，验证通过后令牌才可用。
 * 序列号、挑战、令牌、HMAC 都不进日志。
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger('CompanionDevice');
  private readonly cipher: DeviceSecretCipher | null;
  /** 同一序列号的激活失败次数限制，防止猜 HMAC 或刷令牌 */
  private readonly failures = new BindAttemptLimiter({
    perUser: 10,
    windowMs: 15 * 60 * 1000,
    maxKeys: 10_000,
  });
  /** 同一序列号请求配置接口的次数限制（每次都会发一个待验证的令牌） */
  private readonly configCalls = new BindAttemptLimiter({
    perUser: 30,
    windowMs: 15 * 60 * 1000,
    maxKeys: 10_000,
  });

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cipher = config.companionDeviceKey
      ? new DeviceSecretCipher(config.companionDeviceKey)
      : null;
  }

  async config(serialNo: string | undefined, websocketUrl: string): Promise<DeviceOtaResponse> {
    const response: DeviceOtaResponse = {
      server_time: { timestamp: Date.now(), timezone_offset: TIMEZONE_OFFSET_MINUTES },
    };
    if (!serialNo || !this.cipher) return response;
    if (this.failures.isBlocked(serialNo) || this.configCalls.isBlocked(serialNo)) return response;
    this.configCalls.recordFailure(serialNo);
    const device = await deviceAuthLookup(this.db, serialNo);
    if (!device?.secret_encrypted || device.status === 'stock') return response;
    const challenge = newChallenge();
    const { token, hash } = newDeviceToken();
    if (!(await issueDeviceToken(this.db, device.id, hash, challenge, DEVICE_TOKEN_TTL_SECONDS))) {
      return response;
    }
    return {
      ...response,
      activation: { message: '', challenge, timeout_ms: ACTIVATION_TIMEOUT_MS },
      websocket: { url: websocketUrl, token, version: 1 },
    };
  }

  async activate(body: {
    serialNo: string;
    challenge: string;
    hmac: string;
    firmware: string | null;
  }): Promise<ActivateResult> {
    if (!this.cipher) return 'unauthorized';
    if (this.failures.isBlocked(body.serialNo)) return 'limited';
    const device = await deviceAuthLookup(this.db, body.serialNo);
    const secret = device?.secret_encrypted
      ? this.cipher.decrypt(device.secret_encrypted, body.serialNo)
      : undefined;
    if (device?.secret_encrypted && !secret) {
      // 密文解不开：COMPANION_DEVICE_KEY 换过或数据被改动，只记设备 id
      this.logger.error(`device secret undecryptable ${JSON.stringify({ deviceId: device.id })}`);
    }
    const ok =
      device !== undefined &&
      secret !== undefined &&
      verifyDeviceHmac(secret, body.challenge, body.hmac) &&
      (await activateDeviceToken(this.db, device.id, body.challenge, body.firmware));
    if (!ok) {
      this.failures.recordFailure(body.serialNo);
      return 'unauthorized';
    }
    return 'ok';
  }

  /** 语音通道连接时认证令牌 */
  connect(token: string): Promise<DeviceConnection | undefined> {
    return connectDevice(this.db, hashDeviceToken(token));
  }
}
