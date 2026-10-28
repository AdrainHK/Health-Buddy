import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { deviceActivateRequestSchema, type DeviceOtaResponse } from '@health-buddy/shared';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { DeviceAuthService } from './device-auth.service.js';

/** 设备通道的地址（规格 3.1）；在 voice-gateway 里挂到 HTTP 服务器的 upgrade 上 */
export const DEVICE_WS_PATH = '/ws/device';

const serialSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/);

/** xiaozhi 的 User-Agent 是“板型/固件版本” */
function firmwareFromUserAgent(ua: string | undefined): string | null {
  const version = ua?.split('/').pop()?.trim();
  return version && /^[A-Za-z0-9._+-]{1,64}$/.test(version) ? version : null;
}

/**
 * 伴侣设备的配置和激活接口（M6 规格 3.1、3.2），按 xiaozhi-esp32 的 OTA 协议：
 * 设备固件里的 OTA 地址配成 https://<域名>/api/device/ota/。
 * 不用会话 Cookie；工作台的会话在这里没有任何作用，设备令牌也不能调用工作台接口（规格 6.4）。
 */
@Controller('device/ota')
export class DeviceOtaController {
  constructor(private readonly auth: DeviceAuthService) {}

  @Public()
  @Get()
  getConfig(
    @Headers('serial-number') serial: string | undefined,
    @Req() req: Request,
  ): Promise<DeviceOtaResponse> {
    return this.config(serial, req);
  }

  @Public()
  @Post()
  @HttpCode(200)
  postConfig(
    @Headers('serial-number') serial: string | undefined,
    @Req() req: Request,
  ): Promise<DeviceOtaResponse> {
    return this.config(serial, req);
  }

  /** 200 激活成功；401 失败（不区分序列号不存在、HMAC 不对、挑战过期）；429 失败太多 */
  @Public()
  @Post('activate')
  async activate(
    @Body() body: unknown,
    @Headers('user-agent') ua: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = deviceActivateRequestSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const result = await this.auth.activate({
      serialNo: parsed.data.serial_number,
      challenge: parsed.data.challenge,
      hmac: parsed.data.hmac,
      firmware: firmwareFromUserAgent(ua),
    });
    if (result === 'ok') res.status(200).json({ ok: true });
    else if (result === 'limited') res.status(429).json({ error: 'too_many_requests' });
    else res.status(401).json({ error: 'unauthorized' });
  }

  private config(serial: string | undefined, req: Request): Promise<DeviceOtaResponse> {
    const valid = serialSchema.safeParse(serial?.trim());
    return this.auth.config(valid.success ? valid.data : undefined, websocketUrl(req));
  }
}

/** 按请求的主机名给出 WebSocket 地址；生产环境在 HTTPS 代理后面，用 wss */
function websocketUrl(req: Request): string {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `${secure ? 'wss' : 'ws'}://${req.headers.host ?? 'localhost'}${DEVICE_WS_PATH}`;
}
