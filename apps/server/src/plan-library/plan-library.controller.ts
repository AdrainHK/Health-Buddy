import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { libraryContentIssues, type LibraryContentIssue } from '@health-buddy/plan-library';
import {
  adminLibraryListQuerySchema,
  exerciseContentSchema,
  exerciseListQuerySchema,
  goalTemplateContentSchema,
  goalTemplateListQuerySchema,
  libraryStatusRequestSchema,
  recipeContentSchema,
  recipeListQuerySchema,
  updateLibraryItemRequestSchema,
  type LibraryItemEventListResponse,
  type LibraryItemType,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { ApiException, badRequest, conflict, forbidden, notFound } from '../common/api-error.js';
import type { Role } from '../db/types.js';
import {
  PlanLibraryRepository,
  type AdminItem,
  type AnyContent,
  type LibraryConflict,
} from './plan-library.repository.js';

const idSchema = z.uuid();

/** 路径里的库名 → 条目类型 */
const TYPES: Record<string, LibraryItemType> = {
  recipes: 'recipe',
  exercises: 'exercise',
  'goal-templates': 'goal_template',
};

const CONTENT_SCHEMAS = {
  recipe: recipeContentSchema,
  exercise: exerciseContentSchema,
  goal_template: goalTemplateContentSchema,
} as const;

/** 能浏览方案库的角色：健管师和三级后台账号。客户（M6 起）显式拒绝 → 404 */
const READERS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin', 'manager'];
const ADMINS: readonly Role[] = ['platform_admin', 'operator_admin', 'org_admin'];

function requireReader(session: ResolvedSession): void {
  if (!READERS.includes(session.role)) throw notFound();
}

/** 后台浏览：三级管理员；健管师用工作台的方案库入口 → 403 */
function requireAdminViewer(session: ResolvedSession): void {
  requireReader(session);
  if (!ADMINS.includes(session.role)) throw forbidden();
}

/** 维护只对平台管理员开放；其他角色 403（按角色拒绝，不涉及任何资源） */
function requirePlatformAdmin(session: ResolvedSession): void {
  requireReader(session);
  if (session.role !== 'platform_admin') throw forbidden();
}

function parseType(type: string): LibraryItemType {
  const t = Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
  if (!t) throw notFound();
  return t;
}

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

/** 内容含禁用词、疾病名称、药名或功效承诺：400，标出字段和位置（规格 2.4、6.4） */
function rejectContent(issues: LibraryContentIssue[]): never {
  throw new ApiException(HttpStatus.BAD_REQUEST, 'invalid_content', { issues });
}

function parseContent(type: LibraryItemType, body: unknown): AnyContent {
  const parsed = CONTENT_SCHEMAS[type].safeParse(body);
  if (!parsed.success) throw badRequest();
  const issues = libraryContentIssues(type, parsed.data);
  if (issues.length) rejectContent(issues);
  return parsed.data;
}

function throwConflict(reason: LibraryConflict): never {
  throw conflict({ reasons: [reason] });
}

function settle<T extends AdminItem>(result: T | LibraryConflict | undefined): { item: T } {
  if (result === undefined) throw notFound();
  if (typeof result === 'string') throwConflict(result);
  return { item: result };
}

/**
 * 方案库（M5 规格 2.4、2.12、6.4）。
 * - GET /api/plan-library/:type[/:id]：健管师和三级后台都能浏览，只有已发布（预览环境含待审定），
 *   停用、草稿的条目 404；不含任何客户数据。
 * - GET /api/admin/plan-library/:type：后台列表（含状态、版本、审定信息）；平台看到全部状态，
 *   协会和机构管理员只读已发布的；健管师 403。
 * - POST、PATCH /api/admin/plan-library/:type[/:id]、POST .../:id/status、GET .../:id/events：
 *   只有平台管理员，其他 403。含禁用词 → 400 invalid_content；发布时缺审定人 → 400；
 *   版本号不对、不是草稿、状态流转不允许 → 409。
 */
@Controller()
export class PlanLibraryController {
  constructor(private readonly repo: PlanLibraryRepository) {}

  @Get('plan-library/:type')
  async list(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Query() query: unknown,
  ) {
    requireReader(session);
    const type = parseType(typeParam);
    switch (type) {
      case 'recipe': {
        const q = recipeListQuerySchema.safeParse(query ?? {});
        if (!q.success) throw badRequest();
        return { items: await this.repo.listRecipes(session, q.data) };
      }
      case 'exercise': {
        const q = exerciseListQuerySchema.safeParse(query ?? {});
        if (!q.success) throw badRequest();
        return { items: await this.repo.listExercises(session, q.data) };
      }
      case 'goal_template': {
        const q = goalTemplateListQuerySchema.safeParse(query ?? {});
        if (!q.success) throw badRequest();
        return { items: await this.repo.listGoalTemplates(session, q.data) };
      }
    }
  }

  @Get('plan-library/:type/:id')
  async detail(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Param('id') id: string,
  ) {
    requireReader(session);
    const item = await this.repo.findUsable(session, parseType(typeParam), parseId(id));
    if (!item) throw notFound();
    return { item };
  }

  @Get('admin/plan-library/:type')
  async adminList(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Query() query: unknown,
  ) {
    requireAdminViewer(session);
    const type = parseType(typeParam);
    const q = adminLibraryListQuerySchema.safeParse(query ?? {});
    if (!q.success) throw badRequest();
    return { items: await this.repo.listAdmin(session, type, q.data) };
  }

  @Get('admin/plan-library/:type/:id/events')
  async events(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Param('id') id: string,
  ): Promise<LibraryItemEventListResponse> {
    requirePlatformAdmin(session);
    const type = parseType(typeParam);
    const item = await this.repo.findAdmin(session, type, parseId(id));
    if (!item) throw notFound();
    return { events: await this.repo.events(session, type, item.id) };
  }

  /** 新增：以草稿保存 */
  @Post('admin/plan-library/:type')
  async create(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Body() body: unknown,
  ) {
    requirePlatformAdmin(session);
    const type = parseType(typeParam);
    return { item: await this.repo.create(session, type, parseContent(type, body)) };
  }

  /** 修改：整条替换内容，code 不能改，只能改草稿；必须带当前版本号 */
  @Patch('admin/plan-library/:type/:id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requirePlatformAdmin(session);
    const type = parseType(typeParam);
    parseId(id);
    const parsed = updateLibraryItemRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const content = parseContent(type, parsed.data.content);
    return settle(await this.repo.update(session, type, id, parsed.data.version, content));
  }

  /** 状态流转；发布前再检查一遍内容（种子导入的条目第一次发布时也要过检查） */
  @Post('admin/plan-library/:type/:id/status')
  @HttpCode(200)
  async status(
    @CurrentSession() session: ResolvedSession,
    @Param('type') typeParam: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requirePlatformAdmin(session);
    const type = parseType(typeParam);
    parseId(id);
    const parsed = libraryStatusRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    return settle(
      await this.repo.setStatus(session, type, id, parsed.data, (item) => {
        const issues = libraryContentIssues(type, item);
        if (issues.length) rejectContent(issues);
      }),
    );
  }
}
