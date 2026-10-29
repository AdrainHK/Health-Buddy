import { Module } from '@nestjs/common';
import { TwinModule } from '../twin/twin.module.js';
import { CheckinsRepository } from './checkins.repository.js';
import { CompanionAdminRepository } from './companion-admin.repository.js';
import { CompanionAdminController, CompanionController } from './companion.controller.js';
import { CompanionRepository } from './companion.repository.js';
import { DeviceAuthService } from './device-auth.service.js';
import { DeviceOtaController } from './device-ota.controller.js';
import { InboxController } from './inbox.controller.js';
import { InboxRepository } from './inbox.repository.js';
import { CompanionPurgeService } from './voice/companion-purge.service.js';
import { DeviceSessionRepository } from './voice/device-session.repository.js';
import { DialogueRepository } from './voice/dialogue.repository.js';
import { CompanionDialogue } from './voice/dialogue.service.js';
import { CompanionSpeech } from './voice/speech.service.js';
import { VoiceGateway } from './voice/voice-gateway.js';

/**
 * AI 健康伴侣“福宝”（M6）：设备、同意、伴侣设置和平台固定话术（第 1 步）；
 * 设备配置和激活接口、语音通道 /ws/device（第 3 步）
 */
@Module({
  imports: [TwinModule],
  controllers: [
    CompanionController,
    CompanionAdminController,
    DeviceOtaController,
    InboxController,
  ],
  providers: [
    CompanionRepository,
    CompanionAdminRepository,
    CheckinsRepository,
    InboxRepository,
    DeviceAuthService,
    DeviceSessionRepository,
    CompanionSpeech,
    DialogueRepository,
    CompanionDialogue,
    CompanionPurgeService,
    VoiceGateway,
  ],
})
export class CompanionModule {}
