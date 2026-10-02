# Telegram entry point for the Manager

Ticket #44 — the founder can now talk to the Manager over Telegram. A small addition on top of #43's Manager agent core, documented briefly rather than at #43's own length since there's no new architectural decision here, just wiring an existing shared interface into an existing bot service.

## A second single-handler registration, same pattern as the first

`TelegramBotService` already had exactly one registration slot for approve/reject button presses (`onApprovalCallback`, used by `ApprovalService`). This ticket adds a second, independent one — `onFounderMessage` — for plain-text messages, following the identical shape: one handler, registered once at boot, with its own `Set<Promise<void>>` (`inFlightMessages`, separate from `inFlightCallbacks`) so `onModuleDestroy` waits for in-flight work from either flow without one blocking the other's shutdown bookkeeping.

`ManagerAgentService.onModuleInit()` registers the handler synchronously, before its own async `initialize()` (the DeepAgents graph build) even starts — a message arriving that early just waits inside `handleMessage`'s own `await this.initPromise`, the same robustness `ApprovalService` already relies on for its callback registration. The handler itself is a one-line adapter: `(chatId, text) => this.handleMessage({ channel: 'telegram', conversationKey: chatId, text }).then((result) => result.reply)` — `conversationKey` is the real Telegram chat ID (not a hardcoded constant), so if the founder's configured chat ID ever changes, the new chat starts a clean conversation thread rather than inheriting another chat's history.

## Reusing `sendAlert`, not adding a new send method

The reply always goes back to the founder's own chat — the only chat this bot ever talks to, already enforced before the handler is ever invoked. `sendAlert(text)` already posts plain text to exactly that chat ID, so the reply path is `this.founderMessageHandler(...).then((reply) => this.sendAlert(reply))` — no new Telegram API call shape needed.

## Turn robustness, found by code review before any live run

Three real gaps `/code-review` caught, all fixed: (1) two messages on the same Telegram conversation arriving close together could invoke the DeepAgents graph concurrently against the same LangGraph `thread_id` — LangGraph doesn't serialize that itself, so `ManagerAgentService.handleMessage` now chains each turn onto whatever's already in flight for that `thread_id`, with a `.catch(() => {})` so one failed turn doesn't permanently wedge the conversation. (2) A turn that ends with no text (DeepAgents' final message carrying only a tool call, say) would send an empty Telegram message body, which Telegram's API rejects — `handleMessage` now falls back to a fixed reply rather than leaving the founder with silence and a swallowed server-side error. (3) `onFounderMessage` was registered in `onModuleInit`, racing `TelegramBotService`'s own `onModuleInit` (which starts polling immediately) — moved to the constructor, the same fix `ApprovalService` already applied to its own job-handler registration for the identical class of ordering bug.

## Live verification

Blocked on the identical two infrastructure gaps #43 already discovered and documented in `docs/adr/0006-manager-agent-core.md` — no real Fireworks/OpenAI API keys exist in this deployment, and LLM Guard's Anonymize scanner model can't download from Hugging Face's CDN on this VPS. Both block any live LLM call regardless of entry point, so re-running the same diagnostic #43 already ran would just reproduce the identical result. Not re-attempted here; see that ADR for the full evidence trail.

- [ ] Read-only Q&A over Telegram, end to end, against the real stack.
- [ ] True end-to-end write over Telegram, end to end, against the real stack.
- [x] Everything short of an actual successful provider response is proven correct: the plain-message routing, reply delivery, non-founder lockdown, and the handler registration itself are all covered by tests exercising the real `TelegramBotService`/`ManagerAgentService` wiring (not just mocks standing in for each other).
