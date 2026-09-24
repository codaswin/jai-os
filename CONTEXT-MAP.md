# Context Map

JAI OS is built on top of a Twenty CRM fork. Most of `packages/*` is stock upstream Twenty and is not modeled here — see its own `CLAUDE.md`. Contexts below are JAI-OS's own additions only.

## Contexts

- [Invoicing](./packages/twenty-apps/internal/invoice/CONTEXT.md): the GST-compliant Invoice object and its tax-type derivation, built as a Twenty Apps-framework app.
- [Agent Runtime](./packages/agent-runtime/CONTEXT.md): the NestJS service hosting JAI OS's agents — Controlled Tool API, LLM Guard, LLM provider wiring, Telegram bot, LangGraph checkpoints.

## Relationships

- **Invoicing → Twenty CRM standard objects**: an Invoice relates to a client via `clientContact` (Person) or `clientCompany` (Company), mirroring how Twenty's own Opportunity object relates to both.
- **Agent Runtime → Twenty CRM**: every read or write goes through the Controlled Tool API — never direct GraphQL or database access. See `jai-os-docs/02-architecture.md` for the full rationale.
