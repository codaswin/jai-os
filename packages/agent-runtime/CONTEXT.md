# Agent Runtime

The NestJS service that will host JAI OS's agents. Currently Phase 2 plumbing (`jai-os-docs/08-build-phases.md`): each module below works and is tested in isolation, but nothing wires them together into a real agent yet — that's Phase 3.

## Language

**Controlled Tool API**:
The only path an agent may use to read or write Twenty — implemented here as `ControlledToolApiService`. Full rationale in `jai-os-docs/02-architecture.md`; this package holds the implementation only. Whitelisted by `TOOL_REGISTRY` — a tool not registered there does not exist as far as a calling agent is concerned.
_Avoid_: direct GraphQL/database access from agent code.

**Action ID**:
The idempotency key a caller passes to `ControlledToolApiService.callTool`. A repeated ID with the same tool and payload replays the original result instead of re-executing; a repeated ID with a different tool or payload is rejected. Still tracked in-memory only (`MAX_TRACKED_ACTIONS`, an LRU-ish cap) — not restart-safe. The durable agent inbox below solves this for queued jobs specifically, but `ControlledToolApiService.callTool` is a separate boundary that can be called directly, not only through the queue; consolidating the two dedup mechanisms is still open, don't treat the in-memory tracking here as the permanent design.

**Durable agent inbox + BullMQ queue**:
`AgentInboxService.submit(actionId, jobName, payload)` — the durable inbox: an `agent_inbox_events` row (in the agent database) is committed before the corresponding BullMQ job is enqueued, and is the actual duplicate-protection record, not BullMQ's own jobId reuse (which stops protecting once a completed job is removed from Redis — see `docs/adr/0002-durable-agent-inbox-and-bullmq-queue.md`). `AgentInboxWorkerService` processes jobs with bounded retries and exponential backoff; a job's terminal state (`completed`/`failed`) is written to that same row from the Worker's own `completed`/`failed` events, since only the Worker can tell a retry-pending failure from an exhausted one. `QueueHealthService` alerts via #16's Telegram bot when the oldest waiting or failed job's age crosses a threshold.
_Avoid_: adding a second duplicate-protection mechanism on top of the inbox row — a new job type registers a case in `AgentInboxWorkerService.runJob` and submits through `AgentInboxService.submit`, it doesn't touch BullMQ's `Queue`/`Worker` directly.

**Fail-closed** (LLM Guard):
`LlmGuardService` treats any transport failure, timeout, or non-2xx response as equivalent to a positive detection, never as "unscanned, so allow." A caller must not add a fallback that lets content through when the guard is unreachable.
_Avoid_: fail-open, best-effort scanning.

**Scanner isolation scan**:
`LlmService.guardInput` calls `LlmGuardService.scanPrompt` twice, each time suppressing the scanners for the other category (`SUPPRESS_TO_ISOLATE_INJECTION` / `SUPPRESS_TO_ISOLATE_PII_AND_TOXICITY`). LLM Guard's response only carries an aggregate `is_valid` plus a per-scanner risk score, not a per-scanner pass/fail — this double-call is how the caller attributes a block to injection specifically versus PII/toxicity, so it can alert on injection attempts without also alerting on every PII hit.

**Agent graph demo**:
`AgentGraphService.runDemo` — an increment-and-persist counter proving the LangGraph Postgres checkpointer survives a process restart. It is not an agent and has no business logic. Don't extend it in place; a real graph replaces it, it doesn't grow out of it.

## Not yet true

Per `jai-os-docs/08-build-phases.md` Phase 2, still missing from this package: Arize Phoenix tracing (ticket #19, open as PR #35) and approval records in isolated storage (ticket #22, blocked by the durable inbox above). `LlmService`, `TelegramBotService`, `ControlledToolApiService`, `AgentGraphService`, and `AgentInboxService` each pass their own tests but do not call each other yet — nothing yet submits a real event to the inbox except its own boot-time demo.
