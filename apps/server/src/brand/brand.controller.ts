import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  brandContentIssues,
  brandLogoPath,
  operatorSlugSchema,
  updateBrandRequestSchema,
  type BrandResponse,
  type PublicBrandResponse,
} from '@health-buddy/shared';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession, Public, type AuthedRequest } from '../auth/decorators.js';
import { LoginRateLimiter } from '../auth/login-rate-limiter.js';
import {
  ApiException,
  badRequest,
  forbidden,
  notFound,
  tooManyRequests,
  unsupportedMediaType,
} from '../common/api-error.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../reports/storage.js';
import { BrandRepository } from './brand.repository.js';
import { checkLogo } from './logo.js';
import { LogoUploadInterceptor } from './logo-upload.interceptor.js';

/** 登录页品牌接口的失败计数（按 IP，查不存在的协会简称时计一次） */
export const BRAND_RATE_LIMITER = Symbol('BRAND_RATE_LIMITER');

function requireOperatorAdmin(session: ResolvedSession): void {
  if (session.role !== 'operator_admin' || !session.operatorId) throw forbidden();
}

/**
 * 协会品牌（M7 规格 2.2、2.3、6.4）。
 * - GET、PUT /api/admin/brand，POST /api/admin/brand/logo：只有运营商管理员改本协会的（Q16 平台不代改），
 *   其他角色 403；含禁用词、主色对比度不够 400 invalid_content（标出字段）。
 * - GET /api/public/brand?slug=、/api/public/brand/logo/:slug：未登录，登录页用；只有公开字段，
 *   协会不存在或已停用 404。Logo 带 nosniff 和 CSP sandbox，直接打开 SVG 也不执行脚本。
 */
@Controller()
export class BrandController {
  private readonly logger = new Logger(BrandController.name);

  constructor(
    private readonly repo: BrandRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(BRAND_RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  @Get('admin/brand')
  async get(@CurrentSession() session: ResolvedSession): Promise<BrandResponse> {
    requireOperatorAdmin(session);
    const brand = await this.repo.get(session);
    if (!brand) throw notFound();
    return { brand };
  }

  @Put('admin/brand')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<BrandResponse> {
    requireOperatorAdmin(session);
    const parsed = updateBrandRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const issues = brandContentIssues(parsed.data);
    if (issues.length) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', { issues });
    }
    const brand = await this.repo.update(session, parsed.data);
    if (!brand) throw notFound();
    return { brand };
  }

  @Post('admin/brand/logo')
  @HttpCode(200)
  @UseInterceptors(LogoUploadInterceptor)
  async uploadLogo(
    @CurrentSession() session: ResolvedSession,
    @Req() req: AuthedRequest & { file?: { buffer: Buffer } },
  ): Promise<BrandResponse> {
    // 拦截器已经查过，这里再查一次，拦截器被移走时也不失守（租户审查 N1）
    requireOperatorAdmin(session);
    const storage = this.storage;
    if (!storage) throw notFound();
    const file = req.file;
    if (!file) throw badRequest();
    const check = checkLogo(file.buffer);
    if (!check.ok) {
      if (check.reason === 'unsupported_type') throw unsupportedMediaType();
      throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', { reasons: [check.reason] });
    }
    const key = `brands/${randomBytes(16).toString('hex')}`;
    await storage.put(key, file.buffer, check.type);
    let result;
    try {
      result = await this.repo.setLogo(session, key, check.type);
    } catch (err) {
      await storage.delete(key).catch(() => undefined);
      throw err;
    }
    if (result.oldKey) {
      // 删旧文件失败不影响这次保存，只记错误类型
      await storage.delete(result.oldKey).catch((e: unknown) => {
        this.logger.warn(`old logo delete failed: ${e instanceof Error ? e.name : 'unknown'}`);
      });
    }
    if (!result.brand) throw notFound();
    return { brand: result.brand };
  }

  @Public()
  @Get('public/brand')
  async publicBrand(
    @Query('slug') slug: unknown,
    @Req() req: AuthedRequest,
  ): Promise<PublicBrandResponse> {
    const { row, slug: found } = await this.findPublic(slug, req);
    return {
      brand: {
        name: row.name,
        primaryColor: row.brand_color,
        loginGreeting: row.login_greeting,
        logoUrl: row.logo_updated_at ? brandLogoPath(found, row.logo_updated_at) : null,
      },
    };
  }

  @Public()
  @Get('public/brand/logo/:slug')
  async logo(
    @Param('slug') slug: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { row } = await this.findPublic(slug, req);
    if (!row.logo_object_key || !row.logo_content_type || !this.storage) throw notFound();
    const body = await this.storage.get(row.logo_object_key);
    res.setHeader('Content-Type', row.logo_content_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    // 协会停用后尽快不再显示（租户审查 N3）；地址带版本号，换 Logo 立即生效
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(body);
  }

  private async findPublic(slug: unknown, req: AuthedRequest) {
    const ip = req.ip ?? 'unknown';
    const key = `brand:${ip}`;
    if (this.limiter.isBlocked(ip, key)) throw tooManyRequests();
    const parsed = operatorSlugSchema.safeParse(slug);
    const row = parsed.success ? await this.repo.publicBrand(parsed.data) : undefined;
    if (!parsed.success || !row) {
      this.limiter.recordFailure(ip, key);
      throw notFound();
    }
    return { row, slug: parsed.data };
  }
}
