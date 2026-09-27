import { Module } from '@nestjs/common';

import { AgentInboxModule } from '../agent-inbox/agent-inbox.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';

@Module({
  imports: [TelegramModule, AgentInboxModule],
  providers: [ApprovalRepository, ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
