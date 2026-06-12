# @meridian/server — Architecture

How the API server is composed, how runtime events flow to WebSocket clients,
and the conventions for extending the server without bypassing domain seams.

## Composition root

`server/lib/app.ts` owns the production singleton and delegates the DI graph to
`server/lib/compose.ts`.

The production graph is intentionally assembled at the edge:

```
getDb() / Drizzle repositories / event journal
getModelGateway()
createProductionAppPorts({ db, gateway, ... })
composeAppServices(ports)
```

`compose.ts` has two distinct responsibilities:

- **Concrete adapter construction**: Drizzle repositories, context/collab stores,
  object store, package store, preferences, results, credit ledger, and provider
  gateways.
- **Pure service wiring**: event hub, checkpoint registry, tool registry/executor,
  late-bound turn runner, child-run coordination, orchestrator, upload/import
  services, and returned `AppServices` aggregate.

`getApp()` caches the resulting `Promise<AppServices>` on a process-global symbol
so hot reloads do not compose duplicate singletons.

## Supabase auth boundary

Meridian uses Supabase for local and production auth. Domain logic works with
canonical `UserId` values from `auth.users`; route and WebSocket boundaries are
responsible for turning cookies/tokens into the current user.

Keep provider-specific auth details in `server/lib/auth*.ts` and app-side
Supabase helpers. Domain repositories should depend on user IDs and explicit
access checks, not on Supabase client objects.

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

## Route conventions

### Adding a command route

1. Add a file under `server/routes/api/` (Nitro file-based routing).
2. Authenticate with `requireAppUser(event)` from `server/lib/auth-gate.ts`.
3. Destructure needed services from the composed app aggregate.
4. Run the domain gate for the resource: project/thread/document access.
5. Call the domain API and return `@meridian/contracts/*` wire shapes only.

## Testing strategy

- **`pnpm test` is deterministic** — pure unit + in-memory adapter conformance;
  DB tests remain opt-in.
- **Database checks** use `@meridian/database` and local Supabase Postgres when
  `RUN_DB_TESTS=1` and `DATABASE_URL` are set.
- **Browser/runtime checks** should use portless HTTPS routes, never raw ports,
  so tests exercise the real proxy/TLS path.

## Cross-module links

→ [../app/.context/CONTEXT.md](../app/.context/CONTEXT.md) — frontend state/transport seams
→ [`server/domains/`](../server/domains/) — projects, threads, context, runtime, packages, collab, storage, billing, observability, preferences
