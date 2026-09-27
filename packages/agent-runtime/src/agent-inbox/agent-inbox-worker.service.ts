import { type Job, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AGENT_INBOX_QUEUE_NAME } from './agent-inbox-queue.provider';
import { DEMO_JOB_NAME } from './agent-inbox.constants';
import { AgentInboxRepository } from './agent-inbox.repository';
import { getJobHandler } from './job-handler-registry';

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

export async function runJob(job: Job): Promise<unknown> {
  if (job.name === DEMO_JOB_NAME) {
    return processDemoJob(job.attemptsMade);
  }

  const handler = getJobHandler(job.name);

  if (!handler) {
    throw new Error(`No handler registered for job "${job.name}"`);
  }

  return handler(job);
}

// BullMQ emits its own 'completed'/'failed' Worker events on every attempt,
// including ones that go on to retry — they are not "this job is done", so
// the terminal inbox status can't be written from them. Determined here
// instead, synchronously inside the awaited processor call: `job.attemptsMade`
// going into this attempt (0 on the first try) plus this one equals the
// count BullMQ will see once it finishes handling the failure.
export function isFinalAttempt(job: Job, error: unknown): boolean {
  if (error instanceof UnrecoverableError) {
    return true;
  }

  const configuredAttempts = job.opts.attempts ?? 1;

  return job.attemptsMade + 1 >= configuredAttempts;
}

@Injectable()
export class AgentInboxWorkerService {
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
  }

  // Not a Nest lifecycle hook: Nest runs every provider's onModuleDestroy in
  // the same module concurrently (Promise.all), not in dependency order, so
  // relying on one to run this doesn't guarantee it finishes before
  // AgentInboxService closes the repository pool this worker still writes
  // to. AgentInboxService.onModuleDestroy calls this explicitly, first.
  // Awaiting worker.close() here waits for any in-flight job's own processing
  // promise — including its markCompleted/markFailed write — to settle
  // first, so that write is never racing a pool that's mid-close.
  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }

  private async process(job: Job): Promise<unknown> {
    await this.repository.markProcessing(job.id as string);

    let result: unknown;

    try {
      result = await runJob(job);
    } catch (error) {
      // A DB failure here must not be mistaken for the job itself failing —
      // runJob already succeeded, so re-throwing (unmarked) lets BullMQ retry
      // the whole attempt, which will also retry this write, rather than
      // recording a misleading "failed" status for a job that actually ran.
      if (isFinalAttempt(job, error)) {
        await this.repository.markFailed(
          job.id as string,
          error instanceof Error ? error.message : String(error),
        );
      }

      throw error;
    }

    await this.repository.markCompleted(job.id as string, result);

    return result;
  }
}
