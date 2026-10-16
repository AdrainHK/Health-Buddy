import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createClientRequestSchema,
  createHealthHistoryItemRequestSchema,
  setRiskTierRequestSchema,
  updateClientRequestSchema,
  updateHealthHistoryItemRequestSchema,
  type ClientListResponse,
  type ClientRecordResponse,
  type ClientResponse,
  type HealthHistoryItemResponse,
  type HealthHistoryListResponse,
  type RiskTierHistoryResponse,
  type RiskTierResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, notFound } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { ClientRecordRepository } from './client-record.repository.js';
import { ClientsRepository } from './clients.repository.js';

const idSchema = z.uuid();

/** 格式不对、不存在、属于别的租户，一律返回“不存在”。 */
function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/**
 * 档案只给健管师和机构管理员看（机构管理员只读，Q14）。
 * 运营商和平台管理员行级安全本来就查不到，这里直接按“不存在”处理。
 */
function requireRecordReader(session: ResolvedSession): void {
  if (session.role !== 'manager' && session.role !== 'org_admin') throw notFound();
}

@Controller('clients')
export class ClientsController {
  constructor(
    private readonly clients: ClientsRepository,
    private readonly records: ClientRecordRepository,
  ) {}

  @Get()
  async list(@CurrentSession() session: ResolvedSession): Promise<ClientListResponse> {
    return { clients: await this.clients.list(session) };
  }

  /** 新建客户（Q13）。只有健管师能建，且只能建在自己名下 */
  @Post()
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<ClientResponse> {
    requireManager(session);
    const parsed = createClientRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return { client: await this.clients.create(session, parsed.data) };
  }

  @Get(':id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ClientResponse> {
    const client = await this.clients.findById(session, parseId(id));
    if (!client) throw notFound();
    return { client };
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ClientResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = updateClientRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const client = await this.clients.update(session, clientId, parsed.data);
    if (!client) throw notFound();
    return { client };
  }

  @Get(':id/record')
  async record(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ClientRecordResponse> {
    requireRecordReader(session);
    const record = await this.records.record(session, parseId(id));
    if (!record) throw notFound();
    return { record };
  }

  @Get(':id/health-history')
  async listHistory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<HealthHistoryListResponse> {
    requireRecordReader(session);
    const items = await this.records.listHistory(session, parseId(id));
    if (!items) throw notFound();
    return { items };
  }

  @Post(':id/health-history')
  async createHistory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<HealthHistoryItemResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = createHealthHistoryItemRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const item = await this.records.createHistory(session, clientId, parsed.data);
    if (!item) throw notFound();
    return { item };
  }

  @Patch(':id/health-history/:itemId')
  async updateHistory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<HealthHistoryItemResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const item = parseId(itemId);
    const parsed = updateHealthHistoryItemRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const updated = await this.records.updateHistory(session, clientId, item, parsed.data);
    if (!updated) throw notFound();
    return { item: updated };
  }

  @Delete(':id/health-history/:itemId')
  @HttpCode(204)
  async deleteHistory(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    requireManager(session);
    const clientId = parseId(id);
    const item = parseId(itemId);
    if (!(await this.records.deleteHistory(session, clientId, item))) throw notFound();
  }

  @Get(':id/risk-tiers')
  async listTiers(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<RiskTierHistoryResponse> {
    requireRecordReader(session);
    const tiers = await this.records.listTiers(session, parseId(id));
    if (!tiers) throw notFound();
    return { tiers };
  }

  /** 手动设定分层，理由必填（规格 2.7）。机构管理员只读，按“不存在”处理 */
  @Post(':id/risk-tiers')
  async setTier(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<RiskTierResponse> {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = setRiskTierRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const tier = await this.records.setTier(session, clientId, parsed.data);
    if (!tier) throw notFound();
    return { tier };
  }
}
