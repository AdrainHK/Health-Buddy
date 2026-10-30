import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  approveArtifactRequestSchema,
  exportArtifactRequestSchema,
  sendHandoffReplyRequestSchema,
  updateArtifactRequestSchema,
  type ArtifactDetailResponse,
  type ClientTextResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, notFound } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { ArtifactsRepository } from './artifacts.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

function found<T>(value: T | undefined): T {
  if (value === undefined) throw notFound();
  return value;
}

/** 产物接口（M1 规格 3.6、第六节）。别人的产物一律 404，状态不对 409。 */
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsRepository) {}

  @Get(':id')
  async detail(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    return found(await this.artifacts.detail(session, parseId(id)));
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    const artifactId = parseId(id);
    const parsed = updateArtifactRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return found(await this.artifacts.update(session, artifactId, parsed.data));
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    const artifactId = parseId(id);
    const parsed = approveArtifactRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return found(await this.artifacts.approve(session, artifactId, parsed.data));
  }

  @Post(':id/revise')
  async revise(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    return found(await this.artifacts.revise(session, parseId(id)));
  }

  /** 导出通俗版图片或 PDF。会记一条导出记录，所以用 POST，并且不允许缓存。 */
  @Post(':id/export')
  @HttpCode(200)
  async export(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    requireManager(session);
    const artifactId = parseId(id);
    const parsed = exportArtifactRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const { file, filename } = found(
      await this.artifacts.exportClientText(
        session,
        artifactId,
        parsed.data.format,
        parsed.data.tz,
      ),
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(file, {
      type: parsed.data.format === 'pdf' ? 'application/pdf' : 'image/png',
      disposition: `attachment; filename="export.${parsed.data.format}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      length: file.length,
    });
  }

  /**
   * 已审核的方案、报告解读同步给伴侣“福宝”（M6 规格 2.8、N12）。别人的产物 404；未审核、不是方案或解读、
   * 客户没有绑定设备或已撤回同意 409（后端和数据库函数双重校验，红线 3）。同步过的再点一次不重复。
   */
  @Post(':id/sync-to-companion')
  @HttpCode(200)
  async syncToCompanion(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    return found(await this.artifacts.syncToCompanion(session, parseId(id)));
  }

  /** 取消同步给伴侣：福宝不再读这份快照。没有在用的同步 409 */
  @Delete(':id/sync-to-companion')
  async withdrawFromCompanion(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    return found(await this.artifacts.withdrawFromCompanion(session, parseId(id)));
  }

  /**
   * /转交回复 审核后发送给福宝（M6 规格 2.4、2.9）：福宝在客户下次唤醒时原样念出。别人的产物或转交 404；
   * 未审核 409 not_approved；转交已回复或关闭 409 handoff_closed；有药名等提醒没确认 400（红线 3，校验都在后端）
   */
  @Post(':id/send-handoff-reply')
  @HttpCode(200)
  async sendHandoffReply(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ArtifactDetailResponse> {
    requireManager(session);
    const artifactId = parseId(id);
    const parsed = sendHandoffReplyRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw badRequest();
    return found(
      await this.artifacts.sendHandoffReply(session, artifactId, parsed.data.acknowledgeWarnings),
    );
  }

  /** 复制通俗版。会记一条复制记录，所以用 POST，并且不允许缓存。 */
  @Post(':id/copy')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async copy(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ClientTextResponse> {
    requireManager(session);
    return { text: found(await this.artifacts.copyClientText(session, parseId(id))) };
  }
}
