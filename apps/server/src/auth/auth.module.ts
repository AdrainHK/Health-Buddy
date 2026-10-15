import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersRepository } from '../users/users.repository.js';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { SessionGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthRepository,
    SessionService,
    UsersRepository,
    { provide: LoginRateLimiter, useFactory: () => new LoginRateLimiter() },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AuthModule {}
