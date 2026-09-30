import { Module } from '@nestjs/common';

import { AgentGraphModule } from '../agent-graph/agent-graph.module';
import { ApprovalModule } from '../approvals/approval.module';
import { ProofActionService } from './proof-action.service';

@Module({
  imports: [AgentGraphModule, ApprovalModule],
  providers: [ProofActionService],
  exports: [ProofActionService],
})
export class ProofActionModule {}
