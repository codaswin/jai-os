import { Module } from '@nestjs/common';

import { LlmGuardModule } from '../llm-guard/llm-guard.module';
import { TelegramModule } from '../telegram/telegram.module';
import { LlmService } from './llm.service';

@Module({
  imports: [LlmGuardModule, TelegramModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
