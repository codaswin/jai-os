# Agent Runtime

The NestJS service that will host JAI OS's agents. Currently Phase 2 plumbing (`jai-os-docs/08-build-phases.md`): each module below works and is tested in isolation, but nothing wires them together into a real agent yet — that's Phase 3.

## Language

**Controlled Tool API**:
The only path an agent may use to read or write Twenty — implemented here as `ControlledToolApiService`. Full rationale in `jai-os-docs/02-architecture.md`; this package holds the implementation only. Whitelisted by `TOOL_REGISTRY` — a tool not registered there does not exist as far as a calling agent is concerned.
_Avoid_: direct GraphQL/database access from agent code.

**Action ID**:
The idempotency key a caller passes to `ControlledToolApiService.callTool`. A repeated ID with the same tool and payload replays the original result instead of re-executing; a repeated ID with a different tool or payload is rejected. Still tracked in-memory only (`MAX_TRACKED_ACTIONS`, an LRU-ish cap) — not restart-safe. The durable agent inbox below solves this for queued jobs specifically, but `ControlledToolApiService.callTool` is a separate boundary that can be called directly, not only through the queue; consolidating the two dedup mechanisms is still open, don't treat the in-memory tracking here as the permanent design.

**Durable agent inbox + BullMQ queue**:
`AgentInboxService.submit(actionId, jobName, payload)` — the durable inbox: an `agent_inbox_events` row (in the agent database) is committed before the corresponding BullMQ job is enqueued, and is the actual duplicate-protection record, not BullMQ's own jobId reuse (which stops protecting once a completed job is removed from Redis — see `docs/adr/0003-durable-agent-inbox-and-bullmq-queue.md`). `AgentInboxWorkerService` processes jobs with bounded retries and exponential backoff; a job's terminal state (`completed`/`failed`) is written from inside the awaited processor itself, never from BullMQ's `Worker` `completed`/`failed` events — those fire on every attempt, including ones that go on to retry, not only once retries are exhausted. `QueueHealthService` alerts via #16's Telegram bot when the oldest waiting or failed job's age crosses a threshold.
_Avoid_: writing terminal inbox status from a BullMQ Worker event listener — see the ADR for why that looked reasonable and wasn't.
_Avoid_: adding a second duplicate-protection mechanism on top of the inbox row — a new job type registers itself in `job-handler-registry.ts` (see `ApprovalService` for the pattern) and submits through `AgentInboxService.submit`, it doesn't touch BullMQ's `Queue`/`Worker` directly.

**Approvals**:
`ApprovalService.propose(actionId, description, payload)` persists a proposed action (`agent_approvals`, bound to its exact payload and an expiry) and sends a Telegram approve/reject request via #16's bot. `ApprovalService.decide(actionId, decision)` — from the Telegram callback, or injected directly in tests — only enqueues a job (via `AgentInboxService.submit`, registered as job name `approval-gated-action` in `job-handler-registry.ts`) once approved; execution re-checks status and exact payload match atomically at call time via `ApprovalRepository.checkAndConsume`, which also transitions `approved` → `executed` so an approval can never authorize a second execution. An approval nobody ever decides on is never enqueued at all, so a periodic sweep (not the queued job itself) is what actually expires it — see `docs/adr/0004-approvals.md` for why the more obvious "poll while pending inside the job" design doesn't work here.
_Avoid_: calling `AgentInboxService.submit` directly for anything that should be approval-gated — always go through `ApprovalService.propose`/`decide`, which is the only path that enforces the gate before a job ever reaches the queue.

**Fail-closed** (LLM Guard):
`LlmGuardService` treats any transport failure, timeout, or non-2xx response as equivalent to a positive detection, never as "unscanned, so allow." A caller must not add a fallback that lets content through when the guard is unreachable.
_Avoid_: fail-open, best-effort scanning.

**Scanner isolation scan**:
`LlmService.guardInput` calls `LlmGuardService.scanPrompt` twice, each time suppressing the scanners for the other category (`SUPPRESS_TO_ISOLATE_INJECTION` / `SUPPRESS_TO_ISOLATE_PII_AND_TOXICITY`). LLM Guard's response only carries an aggregate `is_valid` plus a per-scanner risk score, not a per-scanner pass/fail — this double-call is how the caller attributes a block to injection specifically versus PII/toxicity, so it can alert on injection attempts without also alerting on every PII hit.

**Agent graph demo**:
`AgentGraphService.runDemo` — an increment-and-persist counter proving the LangGraph Postgres checkpointer survives a process restart. It is not an agent and has no business logic. Don't extend it in place; a real graph replaces it, it doesn't grow out of it.

**Tracing**:
Every `LlmService.generate()` call and every `ControlledToolApiService.callTool` call are traces in one Arize Phoenix project — `generate()` automatically via `registerTelemetry` (`src/tracing/tracing.ts`), tool calls via `traceTool` wrapping `callTool`. Best-effort: a tracing-setup failure is logged, never fatal, and `agent-runtime` does not depend on `phoenix` being up to start. Full rationale in `docs/adr/0002-arize-phoenix-tracing.md`, including why loading `@ai-sdk/otel`/`@arizeai/openinference-vercel` needs the `importEsm` indirection in that file rather than a normal import.

## Not yet true

Per `jai-os-docs/08-build-phases.md` Phase 2, all of this package's own plumbing tickets are done (see `docs/adr/0004-approvals.md` for the current handoff to #25, the true end-to-end proof action). `LlmService`, `TelegramBotService`, `ControlledToolApiService`, `AgentGraphService`, `AgentInboxService`, and `ApprovalService` each pass their own tests but do not call each other for anything real yet — no tool is actually gated by an approval, and nothing submits a real event to the inbox except each service's own boot-time demo.
