import { Controller, Get, Param } from '@nestjs/common';
import type { ClientListResponse, ClientResponse } from '@health-buddy/shared';
import { z } from 'zod';
import type { ResolvedSession } from '../auth/auth.repository.js';
import { CurrentSession } from '../auth/decorators.js';
import { notFound } from '../common/api-error.js';
import { ClientsRepository } from './clients.repository.js';

const idSchema = z.uuid();

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsRepository) {}

  @Get()
  async list(@CurrentSession() session: ResolvedSession): Promise<ClientListResponse> {
    return { clients: await this.clients.list(session) };
  }

  @Get(':id')
  async get(
    @CurrentSession() session: ResolvedSession,
    @Param('id') id: string,
  ): Promise<ClientResponse> {
    // 格式不对、不存在、属于别的租户，一律返回“不存在”。
    if (!idSchema.safeParse(id).success) throw notFound();
    const client = await this.clients.findById(session, id);
    if (!client) throw notFound();
    return { client };
  }
}
