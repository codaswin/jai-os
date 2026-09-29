import { Module } from '@nestjs/common';

import { AgentInboxModule } from '../agent-inbox/agent-inbox.module';
import { ControlledToolApiModule } from '../controlled-tool-api/controlled-tool-api.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';

@Module({
  imports: [TelegramModule, AgentInboxModule, ControlledToolApiModule],
  providers: [ApprovalRepository, ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
