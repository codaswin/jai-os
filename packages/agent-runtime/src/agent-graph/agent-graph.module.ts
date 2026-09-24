import { Module } from '@nestjs/common';

import { AgentGraphService } from './agent-graph.service';

@Module({
  providers: [AgentGraphService],
  exports: [AgentGraphService],
})
export class AgentGraphModule {}
