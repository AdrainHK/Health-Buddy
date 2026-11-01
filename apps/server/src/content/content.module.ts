import { Module } from '@nestjs/common';
import { ContentRulesController } from './content-rules.controller.js';
import { ContentRulesRepository } from './content-rules.repository.js';

@Module({
  controllers: [ContentRulesController],
  providers: [ContentRulesRepository],
})
export class ContentModule {}
