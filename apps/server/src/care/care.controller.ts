import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  VISIT_MATERIAL_CONSENT_REQUIRED,
  VISIT_MATERIAL_TEXT_MAX,
  createAddendumRequestSchema,
  createVisitMaterialRequestSchema,
  createVisitRequestSchema,
  endCarePlanRequestSchema,
  timeZoneSchema,
  updateVisitRequestSchema,
  visitListQuerySchema,
  type AdherenceResponse,
  type CarePlanListResponse,
  type CarePlanResponse,
  type TodayVisitsResponse,
  type VisitListResponse,
  type VisitMaterialListResponse,
  type VisitRecordListResponse,
  type VisitRecordResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import {
  ApiException,
  badRequest,
  conflict,
  notConfigured,
  notFound,
  payloadTooLarge,
  tooManyRequests,
} from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { isValidTimeZone } from '../twin/time-zone.js';
import { CarePlansRepository } from './care-plans.repository.js';
import { MaterialCipher } from './material-cipher.js';
import { VisitMaterialsRepository } from './visit-materials.repository.js';
import { VisitRecordsRepository } from './visit-records.repository.js';
import { VisitsRepository, type VisitWriteResult } from './visits.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/** 浏览器传来的时区：格式对、并且这台服务器认识，否则按请求不对处理 */
function parseTz(tz: unknown): string | undefined {
  if (tz === undefined) return undefined;
  const parsed = timeZoneSchema.safeParse(tz);
  if (!parsed.success || !isValidTimeZone(parsed.data)) throw badRequest();
  return parsed.data;
}

function settleVisit(result: VisitWriteResult) {
  switch (result) {
    case 'not_found':
    case 'linked_not_found':
      throw notFound();
    case 'closed':
      throw conflict();
    case 'invalid_date':
      throw badRequest();
    default:
      return { visit: result };
  }
}

/**
 * 方案、随访日程、今日随访、随访素材和随访记录（M5 规格 2.6–2.9、6.4）。
 * 只有服务这位客户的健管师能用；机构管理员、运营商、平台一律 404（Q28）。
 * 别人的客户、方案、随访、素材、记录都按不存在处理（404），不写任何行。
 * 方案文字、重点、备注、素材原文和记录内容都不进日志。
 */
@Controller()
export class CareController {
  private readonly cipher: MaterialCipher | null;

  constructor(
    private readonly plans: CarePlansRepository,
    private readonly visits: VisitsRepository,
    private readonly materials: VisitMaterialsRepository,
    private readonly records: VisitRecordsRepository,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.cipher = config.visitMaterialKey ? new MaterialCipher(config.visitMaterialKey) : null;
  }

  // ---------- 方案 ----------

  @Get('clients/:id/care-plans')
  async listPlans(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CarePlanListResponse> {
    requireManager(session);
    const result = await this.plans.list(session, parseId(id));
    if (!result) throw notFound();
    return result;
  }

  @Get('clients/:id/care-plans/current/adherence')
  async adherence(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Query('tz') tz: unknown,
  ): Promise<{ adherence: AdherenceResponse | null }> {
    requireManager(session);
    const result = await this.plans.adherence(session, parseId(id), parseTz(tz));
    if (result === undefined) throw notFound();
    return { adherence: result };
  }

  @Get('care-plans/:id')
  async getPlan(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<CarePlanResponse> {
    requireManager(session);
    const plan = await this.plans.get(session, parseId(id));
    if (!plan) throw notFound();
    return { plan };
  }

  /** 结束方案，原因必填；已结束、已被替代 → 409 */
  @Post('care-plans/:id/end')
  @HttpCode(200)
  async endPlan(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireManager(session);
    const planId = parseId(id);
    const parsed = endCarePlanRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const result = await this.plans.end(session, planId, parsed.data.reason);
    if (result === 'not_found') throw notFound();
    if (result === 'not_active') throw conflict();
    return { plan: result };
  }

  // ---------- 随访 ----------

  @Get('visits/today')
  todayVisits(
    @CurrentSession() session: ResolvedSession,
    @Query('tz') tz: unknown,
  ): Promise<TodayVisitsResponse> {
    requireManager(session);
    return this.visits.today(session, parseTz(tz));
  }

  @Get('visits')
  async listVisits(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<VisitListResponse> {
    requireManager(session);
    const parsed = visitListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw badRequest();
    const visits = await this.visits.list(session, parsed.data);
    if (!visits) throw notFound();
    return { visits };
  }

  /** 加一次随访（可带跟进项） */
  @Post('clients/:id/visits')
  async createVisit(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('tz') tz: unknown,
  ) {
    requireManager(session);
    const clientId = parseId(id);
    const parsed = createVisitRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return settleVisit(await this.visits.create(session, clientId, parsed.data, parseTz(tz)));
  }

  /** 完成、未联系上、改期、取消 */
  @Patch('visits/:id')
  async updateVisit(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('tz') tz: unknown,
  ) {
    requireManager(session);
    const visitId = parseId(id);
    const parsed = updateVisitRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return settleVisit(await this.visits.update(session, visitId, parsed.data, parseTz(tz)));
  }

  // ---------- 随访素材 ----------

  /** 上传素材（粘贴的文字或本地读出的 .txt 内容）。超过 20000 字 → 413；首次未勾选“已告知客户” → 400 */
  @Post('clients/:id/visit-materials')
  async createMaterial(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireManager(session);
    const clientId = parseId(id);
    if (!this.cipher) throw notConfigured();
    const raw = (body as { text?: unknown } | null)?.text;
    // 和契约的 zod 校验同一种计数方式（UTF-16 长度），不会出现 413 和 400 对不上
    if (typeof raw === 'string' && raw.trim().length > VISIT_MATERIAL_TEXT_MAX) {
      throw payloadTooLarge('text_too_long');
    }
    const parsed = createVisitMaterialRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const result = await this.materials.create(session, clientId, parsed.data, this.cipher);
    switch (result) {
      case 'not_found':
      case 'visit_not_found':
        throw notFound();
      case 'consent_required':
        throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', {
          reasons: [VISIT_MATERIAL_CONSENT_REQUIRED],
        });
      case 'daily_limit':
        throw tooManyRequests(['daily_limit']);
      default:
        return { material: result };
    }
  }

  @Get('clients/:id/visit-materials')
  async listMaterials(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<VisitMaterialListResponse> {
    requireManager(session);
    const result = await this.materials.list(session, parseId(id));
    if (!result) throw notFound();
    return result;
  }

  @Delete('visit-materials/:id')
  @HttpCode(204)
  async deleteMaterial(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<void> {
    requireManager(session);
    if (!(await this.materials.remove(session, parseId(id)))) throw notFound();
  }

  // ---------- 随访记录 ----------

  @Get('clients/:id/visit-records')
  async listRecords(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<VisitRecordListResponse> {
    requireManager(session);
    const records = await this.records.list(session, parseId(id));
    if (!records) throw notFound();
    return { records };
  }

  @Get('visit-records/:id')
  async getRecord(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<VisitRecordResponse> {
    requireManager(session);
    const record = await this.records.get(session, parseId(id));
    if (!record) throw notFound();
    return { record };
  }

  /** 补充说明（记录确认后只能追加） */
  @Post('visit-records/:id/addenda')
  async addAddendum(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VisitRecordResponse> {
    requireManager(session);
    const recordId = parseId(id);
    const parsed = createAddendumRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const record = await this.records.addAddendum(session, recordId, parsed.data.text);
    if (!record) throw notFound();
    return { record };
  }
}
