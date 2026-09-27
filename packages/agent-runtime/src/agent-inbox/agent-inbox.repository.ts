import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { type InboxEventRecord, type InboxEventStatus } from './types';

const toRecord = (row: {
  action_id: string;
  job_name: string;
  payload: unknown;
  status: InboxEventStatus;
  result: unknown;
  error: string | null;
}): InboxEventRecord => ({
  actionId: row.action_id,
  jobName: row.job_name,
  payload: row.payload,
  status: row.status,
  result: row.result,
  error: row.error,
});

// pg only auto-serializes a plain object/array parameter into a jsonb column;
// a bare top-level string (unlike a number or boolean, which happen to be
// valid JSON text on their own) is sent as raw unquoted text and fails
// jsonb's implicit cast. Stringifying explicitly is correct for every shape,
// not just the ones that happened to work by coincidence. `undefined` stays
// `undefined` (binds as SQL NULL) rather than becoming the string "undefined".
const toJsonParam = (value: unknown): string | undefined =>
  value === undefined ? undefined : JSON.stringify(value);

// The durable agent inbox: an inbound event is committed here before it's
// acknowledged, so a crash between "received" and "enqueued in BullMQ" never
// silently drops it — AgentInboxService's recovery pass re-enqueues any row
// left pending/processing with no matching job. Also the authoritative
// duplicate-protection record: submit() only enqueues on the first insert of
// a given action ID, unlike BullMQ's own jobId dedup, which stops protecting
// once a completed job is removed from Redis (see AgentInboxService).
@Injectable()
export class AgentInboxRepository {
  private readonly pool: Pool;

  constructor(configService: ConfigService) {
    this.pool = new Pool({
      connectionString: configService.getOrThrow<string>('AGENT_DB_URL'),
    });
  }

  // Not a Nest lifecycle hook, deliberately: Nest runs every provider's
  // onModuleDestroy in a module concurrently, not in dependency order, so
  // implementing OnModuleDestroy here wouldn't guarantee this runs after the
  // consumers still writing through this pool have stopped. AgentInboxService
  // calls this explicitly, last, once those consumers are already closed.
  async close(): Promise<void> {
    await this.pool.end();
  }

  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_inbox_events (
        action_id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  // Returns the newly inserted record, or null if an event with this action
  // ID already existed (the caller's signal not to enqueue a second job).
  async insertIfAbsent(
    actionId: string,
    jobName: string,
    payload: unknown,
  ): Promise<InboxEventRecord | null> {
    const result = await this.pool.query(
      `INSERT INTO agent_inbox_events (action_id, job_name, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (action_id) DO NOTHING
       RETURNING action_id, job_name, payload, status, result, error`,
      [actionId, jobName, toJsonParam(payload)],
    );

    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async find(actionId: string): Promise<InboxEventRecord | null> {
    const result = await this.pool.query(
      `SELECT action_id, job_name, payload, status, result, error
       FROM agent_inbox_events WHERE action_id = $1`,
      [actionId],
    );

    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async markProcessing(actionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_inbox_events SET status = 'processing', updated_at = now() WHERE action_id = $1`,
      [actionId],
    );
  }

  async markCompleted(actionId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE agent_inbox_events
       SET status = 'completed', result = $2, error = NULL, updated_at = now()
       WHERE action_id = $1`,
      [actionId, toJsonParam(result)],
    );
  }

  async markFailed(actionId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_inbox_events
       SET status = 'failed', error = $2, updated_at = now()
       WHERE action_id = $1`,
      [actionId, error],
    );
  }

  // Rows still pending/processing after a restart: either the process died
  // before ever calling queue.add (pending), or it died mid-job in a way that
  // left the inbox row stale (processing but no live job — a genuine gap
  // between the inbox and Redis, not the normal BullMQ stalled-job path,
  // which resumes the job itself without any help from this table).
  async findRecoverable(): Promise<InboxEventRecord[]> {
    const result = await this.pool.query(
      `SELECT action_id, job_name, payload, status, result, error
       FROM agent_inbox_events WHERE status IN ('pending', 'processing')`,
    );

    return result.rows.map(toRecord);
  }
}
