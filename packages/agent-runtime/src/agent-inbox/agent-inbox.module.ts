import { Module } from '@nestjs/common';

import { TelegramModule } from '../telegram/telegram.module';
import { agentInboxQueueProvider, agentRedisConnectionProvider } from './agent-inbox-queue.provider';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentInboxWorkerService } from './agent-inbox-worker.service';
import { AgentInboxService } from './agent-inbox.service';
import { QueueHealthService } from './queue-health.service';

@Module({
  imports: [TelegramModule],
  providers: [
    agentRedisConnectionProvider,
    agentInboxQueueProvider,
    AgentInboxRepository,
    AgentInboxService,
    AgentInboxWorkerService,
    QueueHealthService,
  ],
  exports: [AgentInboxService],
})
export class AgentInboxModule {}
