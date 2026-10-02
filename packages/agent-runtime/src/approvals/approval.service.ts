import { type Job, UnrecoverableError } from 'bullmq';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { AgentInboxService } from '../agent-inbox/agent-inbox.service';
import { registerJobHandler } from '../agent-inbox/job-handler-registry';
import { ControlledToolApiService } from '../controlled-tool-api/controlled-tool-api.service';
import { type AgentIdentity } from '../controlled-tool-api/types';
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

// Used for every approval-gated tool call this service executes. Broad
// enough to cover every gated tool registered so far (ticket #25's proof
// action, ticket #43's generic CRM writes); real per-caller identity
// propagation for a Phase 3+ agent proposing its own approval-gated actions
// is still explicitly out of scope here — see CONTEXT.md. A new
// approval-gated tool needing a scope outside this list will fail loudly
// with PermissionScopeError, not silently execute under the wrong identity.
const APPROVAL_EXECUTION_IDENTITY: AgentIdentity = {
  agentId: 'approval-execution',
  scopes: ['note:write', 'crm:write'],
};

@Injectable()
export class ApprovalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalService.name);
  private initPromise: Promise<void> = Promise.resolve();
  private expirySweepIntervalHandle: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: ApprovalRepository,
    private readonly telegramBot: TelegramBotService,
    private readonly agentInbox: AgentInboxService,
    private readonly controlledToolApi: ControlledToolApiService,
  ) {
    // Registered here, not in onModuleInit: Nest constructs every provider in
    // the app (across every module) before calling any lifecycle hook, but
    // does NOT guarantee which module's onModuleInit runs first — and
    // AgentInboxService's onModuleInit kicks off inbox recovery, which reads
    // this registration via getJobOptions. Registering in onModuleInit would
    // make correctness depend on module init ordering nothing here actually
    // enforces; the constructor phase is the one boundary Nest does
    // guarantee precedes every onModuleInit in the app.
    registerJobHandler(
      APPROVAL_GATED_JOB_NAME,
      (job) => this.executeApprovalGatedJob(job),
      {
        attempts: APPROVAL_JOB_ATTEMPTS,
        backoff: { type: 'fixed', delay: APPROVAL_POLL_INTERVAL_MS },
      },
    );
  }

  onModuleInit(): void {
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

  // toolName is null for a generic approval with no real tool behind it
  // (ticket #22's own boot demo); set for one gating a real Controlled Tool
  // API call (ticket #25) — executeApprovalGatedJob branches on it.
  //
  // Commits the proposal before sending the Telegram request, so a crash
  // between the two never leaves a Telegram message referencing an action ID
  // nothing durable backs — the founder tapping a stale button just finds no
  // pending approval to decide. If this action ID was already proposed, the
  // existing record is returned and no second Telegram message is sent.
  async propose(
    actionId: string,
    toolName: string | null,
    description: string,
    payload: unknown,
  ): Promise<ApprovalRecord> {
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    const inserted = await this.repository.insertIfAbsent(
      actionId,
      description,
      toolName,
      payload,
      expiresAt,
    );

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

    // A prior attempt already ran the real work and recorded it (checked
    // *before* calling the tool below, not only via checkAndConsume's own
    // outcome — see why in the comment above the tool call).
    if (approval.status === 'executed') {
      return { executed: true, alreadyExecuted: true };
    }

    // approval.status === 'approved' from here. The real work happens
    // *before* the CAS that marks it 'executed', deliberately — an earlier
    // version of this method called checkAndConsume first, which meant a
    // crash between the CAS succeeding and the tool call completing would
    // leave the approval permanently marked 'executed' even though the real
    // Twenty-side write never happened: silent data loss, not just a
    // duplicate risk. With the tool called first, a crash here instead
    // leaves the approval still 'approved', so BullMQ's own retry re-enters
    // this method and tries the tool again — safe only because the tool's
    // own execute() is independently idempotent (see its own doc comment),
    // not because this method's ordering alone accomplishes it.
    const toolResult = approval.toolName
      ? await this.controlledToolApi.callApprovedTool(
          APPROVAL_EXECUTION_IDENTITY,
          approval.toolName,
          job.data,
          actionId,
        )
      : undefined;

    const consumed = await this.repository.checkAndConsume(actionId, job.data);

    if (consumed.outcome === 'not-authorized') {
      if (!approval.toolName) {
        // Unlike the tool branch below, no real work happened here — there's
        // nothing idempotent to protect against a retry, so this must not be
        // reported as a success. Thrown as a plain Error (retryable, not
        // Unrecoverable): the next attempt re-fetches the approval from the
        // top of this method and resolves to whatever its state actually
        // become (rejected/expired -> UnrecoverableError there; still
        // approved -> tries the CAS again), rather than this branch trying
        // to re-derive that terminal outcome itself.
        throw new Error(
          `Approval ${actionId} could not be recorded as executed: ${consumed.reason}`,
        );
      }

      // The real work above already happened (and, for a real tool, is
      // safely idempotent) — this can only mean something changed
      // underneath us since the fetch above, not a normal flow. Logged, not
      // thrown: throwing would make BullMQ retry a tool call that already
      // succeeded.
      this.logger.error(
        `Approval ${actionId}'s real work completed but checkAndConsume then reported not-authorized: ${consumed.reason}`,
      );
    }

    return {
      executed: true,
      alreadyExecuted: consumed.outcome === 'already-executed',
      result: toolResult,
    };
  }

  private async runDemo(): Promise<void> {
    try {
      await this.repository.setup();
      await this.propose(DEMO_ACTION_ID, null, 'Approvals demo action', { message: 'approvals demo' });
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
