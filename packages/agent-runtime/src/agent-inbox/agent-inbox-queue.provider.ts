import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const AGENT_INBOX_QUEUE_NAME = 'agent-inbox';

// Tokens, not concrete classes, so tests can substitute a mock queue/
// connection the same way controlled-tool-api.service.spec.ts substitutes a
// mock TwentyGraphqlClientService — bullmq's Queue and ioredis's connection
// are real network clients, no different in kind from that GraphQL client.
export const AGENT_REDIS_CONNECTION = 'AGENT_REDIS_CONNECTION';
export const AGENT_INBOX_QUEUE = 'AGENT_INBOX_QUEUE';

export const agentRedisConnectionProvider: Provider = {
  provide: AGENT_REDIS_CONNECTION,
  useFactory: (configService: ConfigService) =>
    new IORedis(configService.getOrThrow<string>('AGENT_REDIS_URL'), {
      // Required by BullMQ: it issues blocking commands that ioredis's
      // default retry behavior isn't compatible with.
      maxRetriesPerRequest: null,
    }),
  inject: [ConfigService],
};

export const agentInboxQueueProvider: Provider = {
  provide: AGENT_INBOX_QUEUE,
  useFactory: (connection: IORedis) => new Queue(AGENT_INBOX_QUEUE_NAME, { connection }),
  inject: [AGENT_REDIS_CONNECTION],
};
