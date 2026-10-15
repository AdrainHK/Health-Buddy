import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  approveArtifactRequestSchema,
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
