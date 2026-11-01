import { Module } from '@nestjs/common';
import { OpsDashboardController } from './ops-dashboard.controller.js';
import { OpsDashboardRepository } from './ops-dashboard.repository.js';

@Module({
  controllers: [OpsDashboardController],
  providers: [OpsDashboardRepository],
})
export class OpsDashboardModule {}
