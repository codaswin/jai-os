import { type Job, UnrecoverableError } from 'bullmq';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AgentInboxService } from '../agent-inbox/agent-inbox.service';
import { registerJobHandler } from '../agent-inbox/job-handler-registry';
import { type ApprovalDecision, TelegramBotService } from '../telegram/telegram-bot.service';
import { ApprovalRepository } from './approval.repository';
import { type ApprovalRecord } from './types';

export const APPROVAL_GATED_JOB_NAME = 'approval-gated-action';

// How long a proposed action waits for a decision before it can never be
// approved again. Long enough for a founder to notice a phone notification
// and tap a button; not configurable via env yet since nothing has asked for
// that, unlike the queue's alert thresholds.
const APPROVAL_TTL_MS = 15 * 60_000;
// How often the queued job re-checks a still-pending approval. Fixed, not
// exponential: the whole point is a steady poll until the TTL above is hit,
// not a shrinking check rate that could leave a long gap near the deadline.
const APPROVAL_POLL_INTERVAL_MS = 15_000;
// Generously above TTL / POLL_INTERVAL so expiry — not attempts running out —
// is what actually ends a stale pending approval; attempts is just a safety
// ceiling that should never bind in practice for a reasonable TTL.
const APPROVAL_JOB_ATTEMPTS = Math.ceil(APPROVAL_TTL_MS / APPROVAL_POLL_INTERVAL_MS) + 10;

// An action nobody ever decides on is never enqueued at all (only decide()
// enqueues, and only on approval), so nothing else would ever notice its
// expiry — this sweep is what actually makes "expire -> never executes" true
// for that realistic case, not just true by nothing having tried yet.
const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

const DEMO_ACTION_ID = 'approval-demo';

@Injectable()
export class ApprovalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalService.name);
  private initPromise: Promise<void> = Promise.resolve();
  private expirySweepIntervalHandle: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: ApprovalRepository,
    private readonly telegramBot: TelegramBotService,
    private readonly agentInbox: AgentInboxService,
  ) {}

  onModuleInit(): void {
    registerJobHandler(
      APPROVAL_GATED_JOB_NAME,
      (job) => this.executeApprovalGatedJob(job),
      {
        attempts: APPROVAL_JOB_ATTEMPTS,
        backoff: { type: 'fixed', delay: APPROVAL_POLL_INTERVAL_MS },
      },
    );

    this.telegramBot.onApprovalCallback(async (actionId, decision) => {
      await this.decide(actionId, decision);
    });

    // Fire-and-forget from the caller's perspective, same reasoning as every
    // other module's boot-time demo in this package: an unreachable agent DB
    // must not block the rest of the app from starting. Tracked so
    // onModuleDestroy can wait for it before closing the pool it still uses.
    this.initPromise = this.runDemo();

    this.expirySweepIntervalHandle = setInterval(() => {
      this.repository
        .expireOverduePending()
        .then((expired) => {
          if (expired.length > 0) {
            this.logger.log(`Expired ${expired.length} approval(s) with no decision: ${expired.join(', ')}`);
          }
        })
        .catch((error) =>
          this.logger.error('Approval expiry sweep failed', error instanceof Error ? error.stack : error),
        );
    }, EXPIRY_SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.expirySweepIntervalHandle);
    await this.initPromise;
    await this.repository.close();
  }

  // Commits the proposal before sending the Telegram request, so a crash
  // between the two never leaves a Telegram message referencing an action ID
  // nothing durable backs — the founder tapping a stale button just finds no
  // pending approval to decide. If this action ID was already proposed, the
  // existing record is returned and no second Telegram message is sent.
  async propose(
    actionId: string,
    description: string,
    payload: unknown,
    ttlMs = APPROVAL_TTL_MS,
  ): Promise<ApprovalRecord> {
    const expiresAt = new Date(Date.now() + ttlMs);
    const inserted = await this.repository.insertIfAbsent(actionId, description, payload, expiresAt);

    if (!inserted) {
      const existing = await this.repository.find(actionId);

      if (!existing) {
        throw new Error(`Approval ${actionId} was not found immediately after a conflict`);
      }

      return existing;
    }

    try {
      await this.telegramBot.sendApprovalRequest(
        `Approval requested: ${description}`,
        actionId,
      );
    } catch (error) {
      this.logger.error(
        'Failed to send Telegram approval request',
        error instanceof Error ? error.stack : error,
      );
    }

    return inserted;
  }

  // The only path from "pending" to a real decision — called from the
  // Telegram callback handler above, and directly by tests (per this
  // ticket's own testing decision: the decision is injected at this seam,
  // not driven through Telegram's actual button UI).
  async decide(actionId: string, decision: ApprovalDecision): Promise<void> {
    const record = await this.repository.decide(actionId, decision);

    if (!record) {
      this.logger.warn(`Ignoring a decision on approval ${actionId}: it was not pending`);

      return;
    }

    if (record.status !== decision) {
      // The CASE in ApprovalRepository.decide flipped it to 'expired' instead
      // — a decision arriving after the founder's own deadline passed.
      this.logger.warn(`Approval ${actionId} expired before this decision was recorded`);

      return;
    }

    if (decision === 'rejected') {
      return;
    }

    await this.agentInbox.submit(actionId, APPROVAL_GATED_JOB_NAME, record.payload);
  }

  // The queued job's own processor: polls a still-pending approval via
  // BullMQ's own retry/backoff (a plain Error just schedules the next check),
  // and ends the job permanently — never executing — for every other
  // non-authorizing outcome (UnrecoverableError skips remaining attempts).
  private async executeApprovalGatedJob(job: Job): Promise<unknown> {
    const actionId = job.id as string;
    const approval = await this.repository.find(actionId);

    if (!approval) {
      throw new UnrecoverableError(`No approval record found for ${actionId}`);
    }

    if (approval.status === 'pending') {
      if (approval.expiresAt.getTime() <= Date.now()) {
        await this.repository.expireIfPending(actionId);
        throw new UnrecoverableError(`Approval ${actionId} expired before a decision was made`);
      }

      throw new Error(`Approval ${actionId} is still awaiting a decision`);
    }

    if (approval.status === 'rejected' || approval.status === 'expired') {
      throw new UnrecoverableError(`Approval ${actionId} was ${approval.status}`);
    }

    const result = await this.repository.checkAndConsume(actionId, job.data);

    if (result.outcome === 'not-authorized') {
      throw new UnrecoverableError(
        `Approval ${actionId} did not authorize execution: ${result.reason}`,
      );
    }

    return { executed: true, alreadyExecuted: result.outcome === 'already-executed' };
  }

  private async runDemo(): Promise<void> {
    try {
      await this.repository.setup();
      await this.propose(DEMO_ACTION_ID, 'Approvals demo action', { message: 'approvals demo' });
      // Simulates the founder tapping Approve — proves propose -> decide ->
      // enqueue -> checkAndConsume end to end without a real Telegram round
      // trip, which this dev/CI environment has no way to drive (see
      // decide()'s own doc comment on why this is also how tests do it).
      await this.decide(DEMO_ACTION_ID, 'approved');
      this.logger.log('Approvals demo proposed and self-approved (or already existed from a prior boot)');
    } catch (error) {
      this.logger.error('Approvals initialization failed', error instanceof Error ? error.stack : error);
    }
  }
}
