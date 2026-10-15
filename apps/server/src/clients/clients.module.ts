import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';
import { ClientsRepository } from './clients.repository.js';

@Module({ controllers: [ClientsController], providers: [ClientsRepository] })
export class ClientsModule {}
