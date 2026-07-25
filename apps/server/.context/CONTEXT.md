# @meridian/server — Architecture

How the API server is composed, how runtime events flow to WebSocket clients,
and the conventions for extending the server without bypassing domain seams.

## Composition root

`server/lib/app.ts` owns the production singleton and binds process resources. `server/lib/compose.ts` defines the `AppServices` aggregate, constructs production adapter ports, keeps test/in-memory service stubs, and owns pure runtime service wiring.

The production graph is intentionally assembled at the edge:

```
getDb() / Drizzle repositories / event journal
createGatewayFromEnv()
createProductionAppPorts({ gateway, repos, hub, ... })
composeAppServices(ports)
```

`app.ts` wires the concrete production graph:

- **Concrete adapters**: Drizzle repositories, context/collab stores, package
  store, project repositories, credit ledger, package fetcher/seeder, and
  provider gateway.
- **Pure service wiring**: event hub, checkpoint registry, tool
  registry/executor, late-bound turn runner, child-run coordination,
  orchestrator, and returned `AppServices` aggregate.

`AppServices` carries both Meridian names and upstream-compatible aliases where
copied route/lib code expects them: `threadRepos` and `threadEventHub` are the
canonical names; `repos` and `hub` are aliases. Keep these aliases explicit
instead of mechanically rewriting copied code one reference at a time.

`getApp()` caches the resulting `Promise<AppServices>` on a process-global symbol
so hot reloads do not compose duplicate singletons.

## Project route surface

upstream-parity routes under `server/routes/api/projects/` keep the upstream
`project` URL and service vocabulary at the API boundary. Meridian product UI
can call the concept "project workspace"; server code preserves the copied route
shape for parity and lower merge risk.

The shipped route surface covers:

- Project CRUD, stats, preferences, working-set snapshots, library, works list,
  work threads, and project thread list/create; account settings expose the
  working-set sync toggle.
- Agent and skill definition reads, saves, revision lists, revision restores,
  restore-original, and agent skill-link patching.
- Package preview/apply, update check/apply, and export.
- Global thread list/create, snapshot, delete, turn cancel, model-request debug,
  and turn-context preview.
- First-party package catalog, builtin agent catalog, readiness, and unknown
  route handling.

Project-scoped handlers gate through `requireProjectOwner` from
`server/domains/projects` before reading or mutating project-owned data.
WorkOS AuthKit is the auth boundary; alternate auth adapter route code is not part of
Meridian Flow. The removed external execution-provider route surface is also out
of scope for Meridian; do not port it back while filling route parity gaps.

## WorkOS auth boundary

Meridian uses WorkOS AuthKit for authentication. Domain logic works with
canonical internal `UserId` values from `public.users`; route and WebSocket
boundaries verify the sealed `wos-session` cookie and provision via
`UserRepository.ensureUser` on first login.

WorkOS user ID is the sole automatic account key. Email is mutable profile
data, not a merge key: if it is already attached to another WorkOS
principal, HTTP auth gates return structured `409 account_link_conflict` and no
account is provisioned or adopted.

Keep provider-specific auth details in `server/lib/auth.ts` and app-side AuthKit
helpers. Domain repositories should depend on user IDs and explicit access
checks, not on WorkOS client objects.

## ThreadEventHub

In-process fan-out over a durable event journal. The orchestrator writes events
through it; WebSocket subscribers read from it.

- **Write path:** append a domain event, project AG-UI protocol events, assign
  monotonic `bigint` sequence numbers, and fan out to active listeners.
- **Read path:** `catchup(threadId, afterSeq)` returns missed events;
  `subscribe(threadId, listener)` adds a live listener.
- **Catchup + subscribe:** live events that arrive during replay are buffered and
  merged so clients do not miss a gap.
- **Eviction:** per-thread hub state is removed after idle timeout.

Hot cache is process-local. Journal rows persist through Drizzle/in-memory
journal adapters selected by composition.

`hub` is an upstream-compatible alias for `threadEventHub` on `AppServices`.

## Event projection pipeline

```
OrchestratorEvent (domain)
    │
    ▼ domains/threads/domain/orchestrator-event-projector.ts
AGUIEvent (protocol)
    │
    ▼ ThreadEventHub assigns seq
SequencedEventInternal { seq: bigint, event: AGUIEvent }
    │
    ▼ ws-thread-handler.ts encodes to WS frames
WsServerMessage { type: "event", threadId, seq: string, event }
```

The projector is stateful: it tracks the current turn to pair stream deltas with
the correct run/message IDs.

## WebSocket auth & resilience

Thread events (`/api/threads/ws`) and Yjs documents (`/ws/yjs`) share hardening
primitives in `server/lib/`:

- **Upgrade-time auth** returns authenticated or deferred-close contexts. There
  is no in-band auth message.
- **Accept-then-close** avoids dev proxy crashes on non-101 upgrade responses.
- **Defensive send** wraps server-initiated sends so timer/listener send failures
  close and clean up peers instead of becoming uncaught background exceptions.

## Thread WS subscription flow

`createThreadWebSocketSession` in `ws-thread-handler.ts`:

1. Authenticated `open()` sends `{ type: "connected", userId, scope }`; deferred
   close emits an error frame and closes.
2. `subscribe` calls the thread/project access gate, then `hub.catchupAndSubscribe`.
3. Server sends `subscribed` with catchup/state/cursor.
4. Live events flow as `{ type: "event", threadId, seq, event }`.
5. `resume` re-subscribes many threads; `unsubscribe` stops one.
6. Route heartbeat sends `ping`; clients reply `pong`. All sends use safe send.

## Model gateway deadlines

`domains/runtime/gateway` enforces a per-attempt wall-clock timeout
(`MODEL_CALL_TIMEOUT_MS`, default 120_000ms). Timeout aborts the in-flight stream
and surfaces as a retryable provider error when no output has been emitted.

## Observability event sink

`server/lib/observability.ts` owns the process-scoped deferred sink used by startup, request observability, crash policy, and app composition. `server/lib/event-sink-factory.ts` keeps the upstream composition seam but only selects Meridian-local sinks: `EVENT_PROVIDER=local` writes structured JSON to stdout and mirrors to `LOG_DIR/YYYY-MM-DD.jsonl` when `LOG_DIR` is set, while `none`/`noop` returns the no-op sink. External provider policy is deliberately not wired into production composition yet; inject another `EventSink` later without changing route or domain code.

In dev, the repository `logs/` tree is generated observability output, not source input. `nitro.config.ts` excludes it through Rolldown's active `watch.exclude` seam so JSONL mirror writes cannot rebuild Nitro and orphan in-flight work. Keep the exclusion rooted at the repository log directory; do not restore the inert legacy Nitro watcher option.

## Route conventions

### Request IDs

Values backed by Postgres `uuid` columns use the request-ID grammar in
`server/lib/uuid.ts`: canonical 36-character hyphenated hexadecimal, any UUID
version/variant bits, case-insensitive on input and lowercase below the
transport boundary. HTTP route cores use `server/lib/request-id.ts` so malformed
IDs become 400 responses before any repository call; thread WebSocket messages
use the same parser and deliberately report not-found.

### Route-core handlers

Heavier routes keep testable route-core functions in `server/lib/*-route.ts`.
The Nitro file under `server/routes/api/...` should authenticate, extract params
and body, delegate to the route-core, then serialize the response.

Route-core functions take a `Deps` interface and plain-data input. They should
not depend on Nitro event objects. This keeps owner gates, validation, package
install/update logic, model-request debug projection, and definition editing
testable with Vitest without booting Nitro.

### Adding a command route

1. Add a file under `server/routes/api/` (Nitro file-based routing).
2. Authenticate with `requireAppUser(event)` from `server/lib/auth-gate.ts`.
3. Destructure needed services from the composed app aggregate.
4. Run the domain gate for the resource: project/thread/document access.
5. Call the domain API and return `@meridian/contracts/*` wire shapes only.

When validation or orchestration is more than a thin route wrapper, extract it
to `server/lib/*-route.ts` and unit-test that route-core directly.

## Testing strategy

- **`pnpm test` is deterministic** — pure unit + in-memory adapter conformance;
  DB tests remain opt-in.
- **Database checks** use `@meridian/database` and local Postgres when
  `RUN_DB_TESTS=1` and `DATABASE_URL` are set.
- **Browser/runtime checks** should use portless HTTPS routes, never raw ports,
  so tests exercise the real proxy/TLS path.

## Cross-module links

→ [../../app/.context/CONTEXT.md](../../app/.context/CONTEXT.md) — frontend state/transport seams
→ [`server/domains/`](../server/domains/) — projects, threads, context, runtime, packages, collab, storage, billing, observability, preferences, working-set
