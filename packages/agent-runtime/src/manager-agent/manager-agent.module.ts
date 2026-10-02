import { Module } from '@nestjs/common';

import { AgentGraphModule } from '../agent-graph/agent-graph.module';
import { ApprovalModule } from '../approvals/approval.module';
import { ControlledToolApiModule } from '../controlled-tool-api/controlled-tool-api.module';
import { LlmModule } from '../llm/llm.module';
import { ManagerAgentService } from './manager-agent.service';

@Module({
  imports: [AgentGraphModule, ApprovalModule, ControlledToolApiModule, LlmModule],
  providers: [ManagerAgentService],
  exports: [ManagerAgentService],
})
export class ManagerAgentModule {}
