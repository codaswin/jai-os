import { type Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AGENT_INBOX_QUEUE_NAME } from './agent-inbox-queue.provider';
import { AgentInboxRepository } from './agent-inbox.repository';
import { DEMO_JOB_NAME } from './agent-inbox.service';

// Fails on its very first attempt and succeeds after — proves the bounded-
// retry-with-backoff acceptance criterion against something real rather than
// only against configuration nobody ever exercises. Harmless: only ever runs
// against the fixed demo action ID, and duplicate protection means it fires
// at most once per fresh database (see DEMO_ACTION_ID in agent-inbox.service).
export function processDemoJob(attemptsMade: number): { echoed: boolean } {
  if (attemptsMade === 0) {
    throw new Error('Simulated transient failure (demo, first attempt only)');
  }

  return { echoed: true };
}

export function runJob(job: Job): unknown {
  switch (job.name) {
    case DEMO_JOB_NAME:
      return processDemoJob(job.attemptsMade);
    default:
      throw new Error(`No handler registered for job "${job.name}"`);
  }
}

@Injectable()
export class AgentInboxWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentInboxWorkerService.name);
  private readonly connection: IORedis;
  private readonly worker: Worker;

  constructor(
    configService: ConfigService,
    private readonly repository: AgentInboxRepository,
  ) {
    this.connection = new IORedis(configService.getOrThrow<string>('AGENT_REDIS_URL'), {
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker(AGENT_INBOX_QUEUE_NAME, (job) => this.process(job), {
      connection: this.connection,
    });

    // Whether a job completes or exhausts retries is a Worker-level
    // determination the processor itself can't cleanly make (a per-call
    // `opts.attempts` override would make attemptsMade-based guessing
    // fragile), so the terminal inbox status is recorded from these events
    // rather than inside process() below.
    this.worker.on('completed', (job) => {
      this.repository
        .markCompleted(job.id as string, job.returnvalue)
        .catch((error) =>
          this.logger.error(
            `Failed to record completion for inbox event ${job.id}`,
            error instanceof Error ? error.stack : error,
          ),
        );
    });

    this.worker.on('failed', (job, error) => {
      if (!job) {
        return;
      }

      this.repository
        .markFailed(job.id as string, error.message)
        .catch((markError) =>
          this.logger.error(
            `Failed to record failure for inbox event ${job.id}`,
            markError instanceof Error ? markError.stack : markError,
          ),
        );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }

  private async process(job: Job): Promise<unknown> {
    await this.repository.markProcessing(job.id as string);

    return runJob(job);
  }
}
