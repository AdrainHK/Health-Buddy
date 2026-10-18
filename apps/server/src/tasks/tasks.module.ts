import { Module } from '@nestjs/common';
import { ExpertsModule } from '../experts/experts.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksRepository } from './tasks.repository.js';

@Module({
  imports: [ExpertsModule],
  controllers: [TasksController],
  providers: [TasksRepository],
  exports: [TasksRepository],
})
export class TasksModule {}
