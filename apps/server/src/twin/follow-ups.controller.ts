import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  followUpListQuerySchema,
  timeZoneSchema,
  updateFollowUpRequestSchema,
  type FollowUpItemResponse,
  type FollowUpListResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, conflict, notFound } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { FollowUpsRepository } from './follow-ups.repository.js';
import { isValidTimeZone } from './time-zone.js';

const idSchema = z.uuid();

/** 浏览器传来的时区：格式对、并且这台服务器认识，否则按请求不对处理 */
function parseTz(tz: unknown): string | undefined {
  if (tz === undefined) return undefined;
  const parsed = timeZoneSchema.safeParse(tz);
  if (!parsed.success || !isValidTimeZone(parsed.data)) throw badRequest();
  return parsed.data;
}

/**
 * 今日跟进清单（M4 规格 2.6、7.4）。只有健管师本人能看和处理自己客户的跟进项；
 * 机构管理员、运营商、平台 → 404（Q20）。
 */
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly repo: FollowUpsRepository) {}

  @Get()
  async list(
    @CurrentSession() session: ResolvedSession,
    @Query() query: Record<string, unknown>,
  ): Promise<FollowUpListResponse> {
    requireManager(session);
    const parsed = followUpListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw badRequest();
    const tz = parseTz(parsed.data.tz);
    const result = await this.repo.list(session, { ...parsed.data, tz });
    if (!result) throw notFound();
    return result;
  }

  /** 已处理、暂缓、忽略、重新打开。危急类不能忽略 → 400 */
  @Patch(':id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('tz') tzParam: unknown,
  ): Promise<FollowUpItemResponse> {
    requireManager(session);
    if (!idSchema.safeParse(id).success) throw notFound();
    const parsed = updateFollowUpRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const tz = parseTz(tzParam);
    const result = await this.repo.update(session, id, parsed.data, tz);
    if (result === 'not_found') throw notFound();
    if (result === 'critical') throw badRequest();
    if (result === 'conflict') throw conflict();
    return { item: result };
  }
}
