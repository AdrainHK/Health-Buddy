import { Module } from '@nestjs/common';
import { LoginRateLimiter } from '../auth/login-rate-limiter.js';
import { ReportsModule } from '../reports/reports.module.js';
import { BRAND_RATE_LIMITER, BrandController } from './brand.controller.js';
import { BrandRepository } from './brand.repository.js';
import { LogoUploadInterceptor } from './logo-upload.interceptor.js';

@Module({
  imports: [ReportsModule],
  controllers: [BrandController],
  providers: [
    BrandRepository,
    LogoUploadInterceptor,
    { provide: BRAND_RATE_LIMITER, useValue: new LoginRateLimiter() },
  ],
})
export class BrandModule {}
