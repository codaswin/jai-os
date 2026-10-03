# Manager Widget

A Twenty App providing the Manager agent's Twenty-embedded chat widget (ticket #45) — one standalone page with one front component, no objects/fields/logic-functions.

## Language

**Manager Agent page**:
A `STANDALONE_PAGE` layout with a single `FRONT_COMPONENT` widget (`manager-chat.front-component.tsx`), reachable from the sidebar for any logged-in user. The sidebar item's own visibility is not the access boundary — every request the widget makes is independently verified server-side (see below).

**Application Access Token**:
What the widget forwards as proof of identity — obtained via `globalThis.frontComponentHostCommunicationApi.requestAccessTokenRefresh()`, a host-injected ambient global, not a named SDK export (twenty-sdk/front-component's public types export only the function's *type*). This is the same token type `twenty-front`'s own front-component renderer uses to let an installed app call back out as the current user — a short-lived, refreshable JWT Twenty's own `JwtAuthStrategy` already accepts on its main GraphQL endpoint, not a separate token scheme. No other front component in this monorepo calls this function directly (`postcard`'s own external-call example uses a static app-level token instead); this is the first real usage.
_Avoid_: trying to read the user's raw session token from cookies/localStorage — the Application Access Token obtained via `requestAccessTokenRefresh` is the sanctioned mechanism for a front component to authenticate an external call as the current user.

**`/agent-api/widget/*`**:
The one path `ops/Caddyfile` exposes publicly for `agent-runtime` — everything else on that service (health checks, boot demos, Telegram polling) stays on the private network. The widget's own `fetch` calls are same-origin through this route, so no CORS configuration exists anywhere in this app or in `agent-runtime`.
_Avoid_: adding a new public route for anything other than the widget's own endpoint without the same deliberate, narrow-exposure reasoning this one got (see `packages/agent-runtime/docs/adr/0008-widget-entry-point.md`).
