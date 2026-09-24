import { Module } from '@nestjs/common';

import { LlmGuardService } from './llm-guard.service';

@Module({
  providers: [LlmGuardService],
  exports: [LlmGuardService],
})
export class LlmGuardModule {}
