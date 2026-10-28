import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  bindCompanionDeviceRequestSchema,
  companionScriptKindSchema,
  companionScriptMax,
  findBannedTerms,
  timeZoneSchema,
  importDeviceBatchRequestSchema,
  recordCompanionConsentRequestSchema,
  revokeCompanionConsentRequestSchema,
  updateCompanionScriptRequestSchema,
  updateCompanionSettingsRequestSchema,
  type CompanionOverview,
  type CompanionScript,
  type CompanionScriptHistoryResponse,
  type CompanionScriptKind,
  type CompanionScriptListResponse,
  type DeviceBatch,
  type DeviceBatchListResponse,
} from '@health-buddy/shared';
import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import {
  ApiException,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
} from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import type { Role } from '../db/types.js';
import { CompanionAdminRepository } from './companion-admin.repository.js';
import { CompanionRepository } from './companion.repository.js';
import { BindAttemptLimiter } from './device-credentials.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest();
  return parsed.data;
}

/** 浏览器时区（?tz=），健管师账号没有设置时区时用来判断“今天”（同 M5） */
function parseTz(tz: unknown): string | undefined {
  if (tz === undefined) return undefined;
  const parsed = timeZoneSchema.safeParse(tz);
  if (!parsed.success) throw badRequest();
  return parsed.data;
}

/**
 * 健管师端的伴侣（M6 规格 2.1、2.8、6.4）。只有服务这位客户的健管师；其他角色和别人的客户一律 404。
 * - GET、PATCH /api/clients/:id/companion：概览、伴侣称呼和语音设置
 * - POST /api/clients/:id/companion/consents、/consents/revoke：线下告知和同意、撤回（Q4、Q5、N4）
 * - POST、DELETE /api/clients/:id/companion/device：绑定（序列号 + 激活码）、解绑（N2）
 * - POST /api/clients/:id/companion/pause、/resume
 * - GET /api/companion/notice：当前的告知书模板（打印用）
 */
@Controller()
export class CompanionController {
  private readonly bindLimiter = new BindAttemptLimiter();

  constructor(
    private readonly repo: CompanionRepository,
    private readonly admin: CompanionAdminRepository,
  ) {}

  @Get('clients/:id/companion')
  async overview(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionOverview> {
    requireManager(session);
    return (await this.repo.overview(session, parseId(id))) ?? notFoundThrow();
  }

  @Patch('clients/:id/companion')
  async settings(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CompanionOverview> {
    requireManager(session);
    const clientId = parseId(id);
    const data = parse(updateCompanionSettingsRequestSchema, body);
    return (await this.repo.updateSettings(session, clientId, data)) ?? notFoundThrow();
  }

  @Post('clients/:id/companion/consents')
  @HttpCode(200)
  async consent(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('tz') tz: unknown,
  ): Promise<CompanionOverview> {
    requireManager(session);
    const clientId = parseId(id);
    const data = parse(recordCompanionConsentRequestSchema, body);
    const result = await this.repo.recordConsent(session, clientId, data, parseTz(tz));
    return consentResult(result);
  }

  @Post('clients/:id/companion/consents/revoke')
  @HttpCode(200)
  async revoke(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('tz') tz: unknown,
  ): Promise<CompanionOverview> {
    requireManager(session);
    const clientId = parseId(id);
    const data = parse(revokeCompanionConsentRequestSchema, body);
    const result = await this.repo.revokeConsent(session, clientId, data, parseTz(tz));
    return consentResult(result);
  }

  @Post('clients/:id/companion/device')
  @HttpCode(200)
  async bind(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CompanionOverview> {
    requireManager(session);
    const clientId = parseId(id);
    const data = parse(bindCompanionDeviceRequestSchema, body);
    if (this.bindLimiter.isBlocked(session.userId)) throw tooManyRequests(['bind_attempts']);
    const result = await this.repo.bind(session, clientId, data);
    if (result === 'not_found') throw notFound();
    if (result === 'unavailable') {
      this.bindLimiter.recordFailure(session.userId);
      throw conflict({ reason: 'device_unavailable' });
    }
    if (result === 'already_bound') throw conflict({ reason: 'already_bound' });
    if (result === 'no_consent') throw conflict({ reason: 'no_consent' });
    return result;
  }

  @Delete('clients/:id/companion/device')
  async unbind(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionOverview> {
    requireManager(session);
    return deviceResult(await this.repo.unbind(session, parseId(id)));
  }

  @Post('clients/:id/companion/pause')
  @HttpCode(200)
  async pause(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionOverview> {
    requireManager(session);
    return deviceResult(await this.repo.setPaused(session, parseId(id), true));
  }

  @Post('clients/:id/companion/resume')
  @HttpCode(200)
  async resume(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionOverview> {
    requireManager(session);
    return deviceResult(await this.repo.setPaused(session, parseId(id), false));
  }

  @Get('companion/notice')
  async notice(@CurrentSession() session: ResolvedSession): Promise<CompanionScript> {
    requireManager(session);
    return (await this.admin.currentNotice(session)) ?? notFoundThrow();
  }
}

const ADMIN_ROLES: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];

/** 平台维护：其他已知角色 403（按角色拒绝，不涉及资源）；未知角色 404 */
function requirePlatformAdmin(session: ResolvedSession): void {
  if (!ADMIN_ROLES.includes(session.role)) throw notFound();
  if (session.role !== 'platform_admin') throw forbidden();
}

function parseKind(kind: string): CompanionScriptKind {
  const parsed = companionScriptKindSchema.safeParse(kind);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/**
 * 平台总后台的伴侣（M6 规格 2.10、6.4）。只有平台管理员。
 * - GET、POST /api/admin/companion/device-batches：出厂批次（N2）；已存在的序列号 409
 * - GET /api/admin/companion/scripts：每种固定话术和告知书模板的当前版本
 * - GET /api/admin/companion/scripts/:kind/versions：修改记录
 * - PUT /api/admin/companion/scripts/:kind：保存新版本；含禁用词 400 invalid_content
 */
@Controller('admin/companion')
export class CompanionAdminController {
  constructor(private readonly repo: CompanionAdminRepository) {}

  @Get('device-batches')
  async batches(@CurrentSession() session: ResolvedSession): Promise<DeviceBatchListResponse> {
    requirePlatformAdmin(session);
    return { batches: await this.repo.batches(session) };
  }

  @Post('device-batches')
  async importBatch(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<DeviceBatch> {
    requirePlatformAdmin(session);
    const data = parse(importDeviceBatchRequestSchema, body);
    const serials = data.devices.map((d) => d.serialNo);
    if (new Set(serials).size !== serials.length) throw badRequest();
    const result = await this.repo.importBatch(session, data);
    if ('duplicates' in result)
      throw conflict({ reason: 'duplicate_serials', serials: result.duplicates });
    return result;
  }

  @Get('scripts')
  async scripts(@CurrentSession() session: ResolvedSession): Promise<CompanionScriptListResponse> {
    requirePlatformAdmin(session);
    return { scripts: await this.repo.currentScripts(session) };
  }

  @Get('scripts/:kind/versions')
  async history(
    @CurrentSession() session: ResolvedSession,
    @Param('kind') kind: string,
  ): Promise<CompanionScriptHistoryResponse> {
    requirePlatformAdmin(session);
    return { versions: await this.repo.history(session, parseKind(kind)) };
  }

  @Put('scripts/:kind')
  async save(
    @CurrentSession() session: ResolvedSession,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ): Promise<CompanionScript> {
    requirePlatformAdmin(session);
    const k = parseKind(kind);
    const { text } = parse(updateCompanionScriptRequestSchema, body);
    if (text.length > companionScriptMax(k)) throw badRequest();
    const issues = findBannedTerms(text);
    if (issues.length) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', {
        issues: issues.map((i) => ({ term: i.term, index: i.index })),
      });
    }
    return this.repo.saveScript(session, k, text);
  }
}

function notFoundThrow(): never {
  throw notFound();
}

function consentResult(
  result: Awaited<ReturnType<CompanionRepository['recordConsent']>>,
): CompanionOverview {
  if (result === 'not_found') throw notFound();
  if (result === 'unknown_notice' || result === 'future_date') throw badRequest();
  if (result === 'not_consented') throw conflict({ reason: 'not_consented' });
  return result;
}

function deviceResult(
  result: Awaited<ReturnType<CompanionRepository['unbind']>>,
): CompanionOverview {
  if (result === 'not_found') throw notFound();
  if (result === 'no_device') throw conflict({ reason: 'no_device' });
  if (result === 'invalid_state') throw conflict({ reason: 'invalid_state' });
  return result;
}
