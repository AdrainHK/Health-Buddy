import { Module } from '@nestjs/common';
import { ClientRecordRepository } from './client-record.repository.js';
import { ClientsController } from './clients.controller.js';
import { ClientsRepository } from './clients.repository.js';

@Module({
  controllers: [ClientsController],
  providers: [ClientsRepository, ClientRecordRepository],
})
export class ClientsModule {}
