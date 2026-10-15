import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.js';
import { TasksRepository } from './tasks.repository.js';

@Module({
  controllers: [TasksController],
  providers: [TasksRepository],
  exports: [TasksRepository],
})
export class TasksModule {}
