import { Module } from '@nestjs/common';
import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactsRepository } from './artifacts.repository.js';

@Module({
  controllers: [ArtifactsController],
  providers: [ArtifactsRepository],
  exports: [ArtifactsRepository],
})
export class ArtifactsModule {}
