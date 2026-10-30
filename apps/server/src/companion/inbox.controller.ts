import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  closeHandoffRequestSchema,
  handleAlertRequestSchema,
  replyHandoffRequestSchema,
  type ClientCompanionCasesResponse,
  type CompanionAlert,
  type CompanionHandoff,
  type CompanionInboxResponse,
  type CompanionMemoryListResponse,
  type CompanionObservation,
  type CompanionObservationListResponse,
  type CompanionSessionListResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, conflict, notFound } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { TwinComputeService } from '../twin/twin-compute.service.js';
import { InboxRepository, type CaseResult } from './inbox.repository.js';
import { assertReplySendable } from './reply-check.js';

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

function caseResult<T>(result: CaseResult<T>): T {
  if (result === 'not_found') throw notFound();
  if (result === 'invalid_state') throw conflict({ reasons: ['invalid_state'] });
  return result;
}

/**
 * 健管师处理福宝的转交、预警、待确认的测量，查看收集信息、聊天和记忆（M6 第 6 步，规格 2.4、2.5、
 * 2.7、2.8、6.4、N10、N13、N18）。只有服务这位客户的健管师；其他角色和别人的资源一律 404（Q28）。
 * - GET /api/companion/inbox：今日跟进“伴侣”分组
 * - POST /api/companion/alerts/:id/handle：处理预警（处理方式必填，不能忽略）
 * - POST /api/companion/handoffs/:id/reply、/close：直接写回复（过禁用词检查）、已电话联系或关闭
 * - POST /api/companion/observations/:id/confirm、/dismiss：确认（写监测）或驳回待确认的测量
 * - GET /api/clients/:id/companion/cases、/observations、/sessions、/memories；
 *   DELETE /api/clients/:id/companion/memories/:memoryId；POST /api/clients/:id/companion/offline-ack
 */
@Controller()
export class InboxController {
  constructor(
    private readonly repo: InboxRepository,
    private readonly twin: TwinComputeService,
  ) {}

  @Get('companion/inbox')
  inbox(@CurrentSession() session: ResolvedSession): Promise<CompanionInboxResponse> {
    requireManager(session);
    return this.repo.inbox(session);
  }

  @Post('companion/alerts/:id/handle')
  @HttpCode(200)
  async handleAlert(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CompanionAlert> {
    requireManager(session);
    const alertId = parseId(id);
    const data = parse(handleAlertRequestSchema, body);
    return caseResult(await this.repo.handleAlert(session, alertId, data.resolution, data.note));
  }

  @Post('companion/handoffs/:id/reply')
  @HttpCode(200)
  async replyHandoff(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CompanionHandoff> {
    requireManager(session);
    const handoffId = parseId(id);
    const { text, acknowledgeWarnings } = parse(replyHandoffRequestSchema, body);
    // 健管师直接写的回复由福宝原文念给客户听，发送前过禁用词检查（规格 2.4、验收 25）；
    // 只给健管师看的提示语不能念给客户（合规审查 S1）；药名、病名、数值评价等先提醒，确认后才发（S2）
    assertReplySendable(text, acknowledgeWarnings);
    return caseResult(await this.repo.replyHandoff(session, handoffId, text));
  }

  @Post('companion/handoffs/:id/close')
  @HttpCode(200)
  async closeHandoff(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CompanionHandoff> {
    requireManager(session);
    const handoffId = parseId(id);
    const { outcome } = parse(closeHandoffRequestSchema, body);
    return caseResult(await this.repo.closeHandoff(session, handoffId, outcome));
  }

  @Post('companion/observations/:id/confirm')
  @HttpCode(200)
  confirmObservation(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionObservation> {
    return this.resolve(session, id, true);
  }

  @Post('companion/observations/:id/dismiss')
  @HttpCode(200)
  dismissObservation(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionObservation> {
    return this.resolve(session, id, false);
  }

  private async resolve(
    session: ResolvedSession,
    id: string,
    confirm: boolean,
  ): Promise<CompanionObservation> {
    requireManager(session);
    const result = await this.repo.resolveObservation(session, parseId(id), confirm);
    if (result === 'not_found') throw notFound();
    // 确认后写进了监测：孪生重算（数据库函数已标“正在更新”）
    if (result.written) void this.twin.requestFromCompanion(result.observation.clientId);
    return result.observation;
  }

  @Get('clients/:id/companion/cases')
  async cases(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ClientCompanionCasesResponse> {
    requireManager(session);
    return (await this.repo.clientCases(session, parseId(id))) ?? notFoundThrow();
  }

  @Get('clients/:id/companion/observations')
  async observations(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionObservationListResponse> {
    requireManager(session);
    const observations = await this.repo.observations(session, parseId(id));
    return observations ? { observations } : notFoundThrow();
  }

  @Get('clients/:id/companion/sessions')
  async sessions(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Query('before') before: unknown,
  ): Promise<CompanionSessionListResponse> {
    requireManager(session);
    let cursor: Date | null = null;
    if (before !== undefined) {
      const parsed = z.iso.datetime().safeParse(before);
      if (!parsed.success) throw badRequest();
      cursor = new Date(parsed.data);
    }
    return (await this.repo.sessions(session, parseId(id), cursor)) ?? notFoundThrow();
  }

  @Get('clients/:id/companion/memories')
  async memories(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CompanionMemoryListResponse> {
    requireManager(session);
    const memories = await this.repo.memories(session, parseId(id));
    return memories ? { memories } : notFoundThrow();
  }

  @Delete('clients/:id/companion/memories/:memoryId')
  @HttpCode(204)
  async deleteMemory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('memoryId') memoryId: string,
  ): Promise<void> {
    requireManager(session);
    if (!(await this.repo.deleteMemory(session, parseId(id), parseId(memoryId)))) {
      throw notFound();
    }
  }

  @Post('clients/:id/companion/offline-ack')
  @HttpCode(204)
  async offlineAck(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<void> {
    requireManager(session);
    if (!(await this.repo.offlineAck(session, parseId(id)))) throw notFound();
  }
}

function notFoundThrow(): never {
  throw notFound();
}
