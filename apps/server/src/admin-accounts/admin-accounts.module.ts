import { Module } from '@nestjs/common';
import { LoginRateLimiter } from '../auth/login-rate-limiter.js';
import { AdminAccountsController, INVITE_RATE_LIMITER } from './admin-accounts.controller.js';
import { AdminAccountsRepository } from './admin-accounts.repository.js';

/** M7 协会和账号开通。接受邀请的失败次数单独限频（和登录分开计数） */
@Module({
  controllers: [AdminAccountsController],
  providers: [
    AdminAccountsRepository,
    { provide: INVITE_RATE_LIMITER, useFactory: () => new LoginRateLimiter() },
  ],
})
export class AdminAccountsModule {}
