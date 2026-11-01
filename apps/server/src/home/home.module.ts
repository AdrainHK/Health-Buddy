import { Module } from '@nestjs/common';
import { HomeController } from './home.controller.js';
import { HomeRepository } from './home.repository.js';

@Module({
  controllers: [HomeController],
  providers: [HomeRepository],
})
export class HomeModule {}
