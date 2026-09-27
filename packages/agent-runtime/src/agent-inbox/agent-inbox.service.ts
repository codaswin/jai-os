import { type Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AGENT_INBOX_QUEUE, AGENT_REDIS_CONNECTION } from './agent-inbox-queue.provider';
import { AgentInboxWorkerService } from './agent-inbox-worker.service';
import { DEMO_JOB_NAME } from './agent-inbox.constants';
import { AgentInboxRepository } from './agent-inbox.repository';
import { getJobOptions } from './job-handler-registry';
import { type InboxEventRecord } from './types';

// Bounded retries with backoff on transient failure (ticket acceptance
// criterion), not unlimited — a permanently broken job fails out to the
// failed-job list instead of hammering a dead dependency forever.
const JOB_ATTEMPTS = 5;
const JOB_BACKOFF_DELAY_MS = 2_000;

// Retention bounds, not correctness: duplicate protection is enforced by the
// Postgres inbox row (submit() below), not by BullMQ's jobId reuse rules,
// which stop protecting once a completed/failed job is removed from Redis.
const KEEP_COMPLETED_JOBS = 1_000;
const KEEP_FAILED_JOBS = 5_000;

const DEFAULT_JOB_OPTIONS = {
  attempts: JOB_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: JOB_BACKOFF_DELAY_MS },
  removeOnComplete: { count: KEEP_COMPLETED_JOBS },
  removeOnFail: { count: KEEP_FAILED_JOBS },
};

// A job type can override these (see ApprovalService, which needs far more
// attempts at a much longer, fixed interval to poll for a decision) — applied
// here rather than left to each caller to remember, so recoverPendingEvents
// below re-enqueues with the same options a normal submit() would have used,
// not silently falling back to the generic defaults.
function buildJobOptions(jobName: string) {
  return { ...DEFAULT_JOB_OPTIONS, ...getJobOptions(jobName) };
}

// A fixed action ID, like AgentGraphService's fixed thread ID and
// ControlledToolApiService's demo action ID: every boot after the first
// finds the row already completed and skips re-enqueueing, which is itself
// the live proof that duplicate protection survives a restart.
const DEMO_ACTION_ID = 'agent-inbox-demo';

// Recovery also runs on this interval, not only at boot: submit() commits the
// Postgres row before calling queue.add, so a queue.add that throws (a
// transient Redis blip, say) leaves a row stuck "pending" with nothing in
// Redis until something re-checks it — on a long-running deploy, boot-only
// recovery could leave that gap open for days.
const RECOVERY_INTERVAL_MS = 60_000;

@Injectable()
export class AgentInboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentInboxService.name);
  private initPromise: Promise<void> = Promise.resolve();
  private recoveryIntervalHandle: NodeJS.Timeout | undefined;

  constructor(
    @Inject(AGENT_REDIS_CONNECTION) private readonly connection: IORedis,
    @Inject(AGENT_INBOX_QUEUE) private readonly queue: Queue,
    private readonly repository: AgentInboxRepository,
    private readonly worker: AgentInboxWorkerService,
  ) {}

  onModuleInit(): void {
    // Fire-and-forget from the caller's perspective, same reasoning as
    // AgentGraphService: an unreachable agent DB/Redis at boot must not block
    // the rest of the app from starting. Tracked so onModuleDestroy can wait
    // for it before closing the connections it's still using.
    this.initPromise = this.initializeAndRunDemo();

    this.recoveryIntervalHandle = setInterval(() => {
      this.recoverPendingEvents().catch((error) =>
        this.logger.error(
          'Periodic inbox recovery failed',
          error instanceof Error ? error.stack : error,
        ),
      );
    }, RECOVERY_INTERVAL_MS);
  }

  // Explicit order, not left to Nest (which runs a module's providers'
  // onModuleDestroy hooks concurrently, not by dependency): the worker closes
  // first, so any in-flight job's own DB write finishes before anything else
  // shuts down, then the queue/connection, then the repository pool last,
  // since both this service and the worker write through it right up until
  // their own close() calls above resolve.
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.recoveryIntervalHandle);
    await this.initPromise;
    await this.worker.close();
    await this.queue.close();
    await this.connection.quit();
    await this.repository.close();
  }

  // Commits the event to the durable inbox before acknowledging it, then
  // enqueues it. If an event with this action ID already exists, the caller
  // already submitted it once — the inbox row is the record, not a new job.
  async submit(actionId: string, jobName: string, payload: unknown): Promise<InboxEventRecord> {
    const inserted = await this.repository.insertIfAbsent(actionId, jobName, payload);

    if (!inserted) {
      const existing = await this.repository.find(actionId);

      if (!existing) {
        throw new Error(`Inbox event ${actionId} was not found immediately after a conflict`);
      }

      return existing;
    }

    await this.queue.add(jobName, payload, { jobId: actionId, ...buildJobOptions(jobName) });

    return inserted;
  }

  // Oldest-job ages for QueueHealthService's threshold checks. Scanned over a
  // bounded window rather than trusting index 0's ordering, since a pile-up
  // of failures should still surface the true oldest one, not just whichever
  // BullMQ happens to return first.
  async getQueueAgeMetrics(): Promise<{
    oldestWaitingAgeMs: number | null;
    oldestFailedAgeMs: number | null;
  }> {
    const [waiting, failed] = await Promise.all([
      this.queue.getWaiting(0, 99),
      this.queue.getFailed(0, 99),
    ]);

    return {
      oldestWaitingAgeMs: oldestAge(waiting.map((job) => job.timestamp)),
      oldestFailedAgeMs: oldestAge(failed.map((job) => job.finishedOn ?? job.timestamp)),
    };
  }

  private async initializeAndRunDemo(): Promise<void> {
    try {
      await this.repository.setup();
      await this.recoverPendingEvents();
      await this.submit(DEMO_ACTION_ID, DEMO_JOB_NAME, { message: 'agent inbox demo' });
      this.logger.log('Agent inbox demo event submitted (or already existed from a prior boot)');
    } catch (error) {
      this.logger.error(
        'Agent inbox initialization failed',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  // Re-enqueues any inbox row left pending/processing with no matching job in
  // Redis — the gap a crash between the DB commit and queue.add (or a lost
  // Redis job despite persistence) would otherwise leave stuck forever. Run
  // at boot and on RECOVERY_INTERVAL_MS above. A worker that merely died
  // mid-job doesn't need this: BullMQ's own stalled-job recovery resumes that
  // once a worker restarts, since the job is still in Redis.
  private async recoverPendingEvents(): Promise<void> {
    const recoverable = await this.repository.findRecoverable();

    for (const event of recoverable) {
      const existingJob = await this.queue.getJob(event.actionId);

      if (existingJob) {
        continue;
      }

      this.logger.warn(`Recovering orphaned inbox event ${event.actionId}: re-enqueueing`);

      await this.queue.add(event.jobName, event.payload, {
        jobId: event.actionId,
        ...buildJobOptions(event.jobName),
      });
    }
  }
}

function oldestAge(timestamps: number[]): number | null {
  if (timestamps.length === 0) {
    return null;
  }

  return Date.now() - Math.min(...timestamps);
}
