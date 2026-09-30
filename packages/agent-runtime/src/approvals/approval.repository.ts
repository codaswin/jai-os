import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { toJsonParam } from '../shared/to-json-param';
import { type ApprovalDecision } from '../telegram/telegram-bot.service';
import { type ApprovalRecord, type ApprovalStatus, type ConsumeOutcome } from './types';

const toRecord = (row: {
  action_id: string;
  description: string;
  tool_name: string | null;
  payload: unknown;
  status: ApprovalStatus;
  expires_at: Date;
}): ApprovalRecord => ({
  actionId: row.action_id,
  description: row.description,
  toolName: row.tool_name,
  payload: row.payload,
  status: row.status,
  expiresAt: row.expires_at,
});

const SELECT_COLUMNS = 'action_id, description, tool_name, payload, status, expires_at';

// A proposed action, bound to its exact payload, an expiry, and a status —
// the founder identity isn't a column since this whole system is
// single-founder (TelegramBotService already only ever talks to one chat
// ID); "whose approval" is implicit, not a fact this table needs to record.
@Injectable()
export class ApprovalRepository {
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({
      connectionString: configService.getOrThrow<string>('AGENT_DB_URL'),
    });
  }

  // Not a Nest lifecycle hook — see AgentInboxRepository.close() for why:
  // Nest destroys a module's providers concurrently, not in dependency
  // order, so ApprovalService calls this explicitly, last.
  async close(): Promise<void> {
    await this.pool.end();
  }

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_approvals (
        action_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Added in ticket #25, after this table already shipped in #22 — a
    // plain CREATE TABLE IF NOT EXISTS above won't add a column to an
    // existing table, so this covers upgrading a database that already has
    // agent_approvals from before this column existed.
    await this.pool.query(`
      ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS tool_name TEXT
    `);
  }

  // Returns the newly inserted record, or null if this action ID was already
  // proposed — propose() treats null as "already proposed, don't re-send the
  // Telegram request", the same idempotency shape as AgentInboxRepository.
  async insertIfAbsent(
    actionId: string,
    description: string,
    toolName: string | null,
    payload: unknown,
    expiresAt: Date,
  ): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `INSERT INTO agent_approvals (action_id, description, tool_name, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (action_id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [actionId, description, toolName, toJsonParam(payload), expiresAt],
    );

    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async find(actionId: string): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM agent_approvals WHERE action_id = $1`,
      [actionId],
    );

    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  // Atomic: a decision only ever lands on a still-pending row, and a decision
  // that arrives after the expiry silently becomes 'expired' instead of the
  // requested decision — so a stale button tap can never approve or reject an
  // action the founder no longer sees as pending. Returns null if the row
  // wasn't pending (already decided, or never existed) — a double-tap or a
  // decision on an unknown action ID, both safely ignored by the caller.
  async decide(actionId: string, decision: ApprovalDecision): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `UPDATE agent_approvals
       SET status = CASE WHEN expires_at < now() THEN 'expired' ELSE $2 END,
           updated_at = now()
       WHERE action_id = $1 AND status = 'pending'
       RETURNING ${SELECT_COLUMNS}`,
      [actionId, decision],
    );

    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  // Transitions a pending-but-overdue row to 'expired', called when the
  // execution job notices its own expiry has passed rather than a founder
  // ever deciding. Same WHERE-status guard, so this can never clobber a
  // decision that landed just before it ran.
  async expireIfPending(actionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_approvals
       SET status = 'expired', updated_at = now()
       WHERE action_id = $1 AND status = 'pending'`,
      [actionId],
    );
  }

  // The realistic expiry path: an action nobody ever responds to is never
  // enqueued at all (decide() is the only thing that enqueues, and only on
  // approval), so nothing would otherwise notice its expiry has passed.
  // Called periodically by ApprovalService. Returns the expired action IDs
  // purely for logging.
  async expireOverduePending(): Promise<string[]> {
    const result = await this.pool.query<{ action_id: string }>(
      `UPDATE agent_approvals
       SET status = 'expired', updated_at = now()
       WHERE status = 'pending' AND expires_at < now()
       RETURNING action_id`,
    );

    return result.rows.map((row) => row.action_id);
  }

  // The authorization gate: atomically consumes an approval — 'approved' with
  // this exact payload — into 'executed', so it can never authorize a second
  // execution. If the CAS affects no row, a follow-up read distinguishes
  // "already executed" (the real work already ran once; a caller retrying
  // after its own completion bookkeeping failed should treat this as success,
  // not re-run anything) from a genuine authorization failure.
  async checkAndConsume(actionId: string, payload: unknown): Promise<ConsumeOutcome> {
    const consumed = await this.pool.query(
      `UPDATE agent_approvals
       SET status = 'executed', updated_at = now()
       WHERE action_id = $1 AND status = 'approved' AND payload = $2::jsonb
       RETURNING action_id`,
      [actionId, toJsonParam(payload)],
    );

    if (consumed.rows.length > 0) {
      return { outcome: 'consumed' };
    }

    const existing = await this.find(actionId);

    if (!existing) {
      return { outcome: 'not-authorized', reason: 'no approval record exists for this action' };
    }

    if (existing.status === 'executed') {
      return { outcome: 'already-executed' };
    }

    if (existing.status === 'approved') {
      return { outcome: 'not-authorized', reason: 'payload does not match the approved payload' };
    }

    return { outcome: 'not-authorized', reason: `approval status is "${existing.status}"` };
  }
}
