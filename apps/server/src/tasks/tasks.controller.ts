import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createTaskRequestSchema,
  listTasksQuerySchema,
  updateTaskRequestSchema,
  type Task,
  type TaskDetailResponse,
  type TaskListResponse,
} from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { badRequest, notFound } from '../common/api-error.js';
import { requireManager } from '../common/manager-only.js';
import { TasksRepository } from './tasks.repository.js';

const idSchema = z.uuid();

function parseId(id: string): string {
  if (!idSchema.safeParse(id).success) throw notFound();
  return id;
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksRepository) {}

  @Get()
  async list(
    @CurrentSession() session: ResolvedSession,
    @Query() query: unknown,
  ): Promise<TaskListResponse> {
    requireManager(session);
    const parsed = listTasksQuerySchema.safeParse(query);
    // clientId 格式不对和看不到的客户一样，按“不存在”处理
    if (!parsed.success) throw notFound();
    const tasks = await this.tasks.list(session, {
      clientId: parsed.data.clientId,
      archived: parsed.data.archived === 'true',
    });
    if (!tasks) throw notFound();
    return { tasks };
  }

  @Post()
  async create(
    @CurrentSession() session: ResolvedSession,
    @Body() body: unknown,
  ): Promise<{ task: Task }> {
    requireManager(session);
    const parsed = createTaskRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw badRequest();
    const task = await this.tasks.create(session, parsed.data);
    if (!task) throw notFound();
    return { task };
  }

  @Get(':id')
  async detail(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<TaskDetailResponse> {
    requireManager(session);
    const detail = await this.tasks.detail(session, parseId(id));
    if (!detail) throw notFound();
    return detail;
  }

  @Patch(':id')
  async update(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ task: Task }> {
    requireManager(session);
    const taskId = parseId(id);
    const parsed = updateTaskRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest();
    const task = await this.tasks.update(session, taskId, parsed.data);
    if (!task) throw notFound();
    return { task };
  }
}
