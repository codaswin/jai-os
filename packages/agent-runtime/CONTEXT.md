# Agent Runtime

The NestJS service that will host JAI OS's agents. Currently Phase 2 plumbing (`jai-os-docs/08-build-phases.md`): each module below works and is tested in isolation, but nothing wires them together into a real agent yet — that's Phase 3.

## Language

**Controlled Tool API**:
The only path an agent may use to read or write Twenty — implemented here as `ControlledToolApiService`. Full rationale in `jai-os-docs/02-architecture.md`; this package holds the implementation only. Whitelisted by `TOOL_REGISTRY` — a tool not registered there does not exist as far as a calling agent is concerned.
_Avoid_: direct GraphQL/database access from agent code.

**Action ID**:
The idempotency key a caller passes to `ControlledToolApiService.callTool`. A repeated ID with the same tool and payload replays the original result instead of re-executing; a repeated ID with a different tool or payload is rejected. Currently tracked in-memory only (`MAX_TRACKED_ACTIONS`, an LRU-ish cap) — not restart-safe. Move this to the agent database once Phase 2's durable inbox work starts; don't treat the in-memory tracking as the permanent design.

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

Per `jai-os-docs/08-build-phases.md` Phase 2, still missing from this package: the BullMQ agent inbox with dedicated Redis, and approval records in isolated storage (tickets #21/#22 — see `docs/adr/0002-arize-phoenix-tracing.md` for the current handoff). `LlmService`, `TelegramBotService`, `ControlledToolApiService`, and `AgentGraphService` each pass their own tests but do not call each other yet.
