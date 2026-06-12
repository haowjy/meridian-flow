# lib — composition root & route-adjacent infrastructure

**The wiring/glue layer.** Not a domain. `lib/` assembles domain adapters into a
running Nitro service, provides the auth seam that gates every route and WS
upgrade, and houses WS handlers that bridge peers to the ThreadEventHub and Yjs
collaboration. Concrete adapters are chosen in `compose.ts`; nothing in
`domains/` depends back on `lib/`.

## Composition / app assembly

| File | Role |
|---|---|
| `env.ts` | Typed env schema via `@t3-oss/env-core` + zod. Single source of truth for server env vars. |
| `db.ts` | Singleton Drizzle `PostgresJsDatabase` client, lazily created from `DATABASE_URL`. |
| `gateway.ts` | Singleton model `Gateway`, lazily constructed via `createGatewayFromEnv()`. |
| `event-sink-factory.ts` | Env-driven observability adapter factory. |
| `object-store-factory.ts` | Env-driven object-store adapter factory. |
| `compose.ts` | `AppServices` type definition, pass-through combinators, and in-memory stub factory for tests/dev. Does **not** contain the production wiring. |
| `app.ts` | App singleton + DI composition root. `getApp()` caches `AppServices` on `Symbol.for("meridian.app.v1")` and calls `createAppServices()` which performs all production wiring. |

### Wiring location

All production wiring lives in `createAppServices()` in `app.ts`. This is the
single composition root that:

1. Creates Drizzle-backed domain adapters (thread repos, journal, credit ledger,
   packages, projects, works, document sync, context port factory).
2. Creates pure/in-memory adapters (preferences, checkpoint registry, noop event
   sink, noop checkpoint artifact flush).
3. Assembles the orchestrator stack in order: gateway, tool registry/executor,
   late-bound `RunTurnPort`, turn runner, child-run coordinator, then
   orchestrator. Binds the proxy after orchestrator construction.
4. Composes an explicit `PermissionGate` with `coding` profile
   (`computeEffectivePermissions(resolveProfile("coding"))`).
5. Passes everything through `createProductionAppPorts()` / `composeAppServices()`
   (currently thin pass-throughs) to form the final `AppServices`.

**`compose.ts`** defines the `AppServices` type, `createProductionAppPorts()`
(pass-through identity), `composeAppServices()` (pass-through identity), and
`createInMemoryAppServices()` (stub factory with `phase: "skeleton"` sentinels
and throwing stubs for unimplemented methods).

**`createInMemoryAppServices()`** — test/dev composition. Creates in-memory stubs
for every `AppServices` slot: gateway echo, skeleton repos, throwing document
sync, noop event sink, pass-through checkpoint registry, and unimplemented throw
stubs for orchestrator/runner/tool executor.

### Late-binding `RunTurnPort`

The turn runner and child-run coordinator both need a `RunTurnPort` (the
orchestrator) before it can be fully constructed (child-run coordinator calls
back into the orchestrator for subagent turns). `createLateBindRunTurnPort()`
creates a proxy that defers to an unbound `RunTurnPort`; `runTurnProxy.bind(orchestrator)`
completes the cycle after the orchestrator is created.

### `AppServices` slots

`compose.ts` defines the canonical `AppServices` type. Every domain port is
represented as a fully-typed slot:

| Slot | Domain | Production adapter |
|---|---|---|
| `gateway` | runtime | Env-driven Anthropic/OpenAI gateway |
| `threadRepos` | threads | Drizzle (turns, blocks, model responses, threads) |
| `journalReader` | threads | Drizzle event journal read |
| `journalWriter` | threads | Drizzle event journal append |
| `threadEventHub` | threads | In-memory pub/sub over journal |
| `threadRuntime` | threads | Thread ownership + message dispatch |
| `documentSync` | collab | Drizzle Yjs document persistence |
| `contextPorts` | context | Drizzle-backed context reader/writer |
| `projects` | projects | Drizzle project repository |
| `works` | projects | Drizzle work repository |
| `creditLedger` | billing | Drizzle credit lot/transaction ledger |
| `agents` | agents | Package store (skeleton) |
| `checkpointRegistry` | runtime | In-memory checkpoint registry |
| `eventSink` | observability | Noop (env-configurable) |
| `packageRepository` | packages | Drizzle package store |
| `preferences` | preferences | In-memory only (Meridian Flow does not persist preferences) |
| `orchestrator` | runtime | `RunTurnPort` — the full orchestrator |
| `runner` | runtime | `TurnRunner` with child-run registry |
| `toolRegistry` | runtime | Name-keyed tool registration map |
| `toolExecutor` | runtime | Dispatches tool calls to registered handlers |
| `modelRequestDebug` | runtime | In-memory debug store for model requests |

## Tool wiring

`app.ts` constructs the runtime tool registry with `{ db, contextPorts }` and
passes it into the orchestrator stack. The concrete registry currently lives in
`domains/runtime/tool-registry.ts`; `lib/` wires it but does not own tool
algorithms.

Context-backed handlers resolve the legacy thread-scoped context port with
`contextPorts.forThread(ctx)`. The factory consumes `threadId` and `userId`;
the caller also carries `assistantTurnId` for agent attribution. That port still
only supports the bootstrap manuscript URI, `work://manuscript/chapter-1.md`;
the richer router/`ContextFS` primitives exported from `domains/context` are
available for future wiring but are not yet the production tool path.

| Tool | Backend |
|---|---|
| `read` | `ContextPortFactory.forThread(ctx).readDocument(uri)` → markdown + document id. |
| `edit` | `editDocument({ uri, transform, origin: { type: "agent", actorTurnId } })`; current edit actions append text. |
| `write` | `writeDocument({ uri, markdown, origin: { type: "agent", actorTurnId } })`. |
| `list` | Returns the single required manuscript URI for the current vertical slice. |
| `search` | Reads the manuscript document and performs a case-insensitive substring search. |
| `ask_user` | Creates a checkpoint component block and keeps the assistant turn interruptible/resumable. |

## Auth and ownership

| File | Role |
|---|---|
| `auth.ts` | Supabase authentication seam. `resolveUser(request)` validates the session cookie; `requireUser(request, deps)` provisions/loads the Meridian Flow user row. |
| `auth-gate.ts` | Single seam combining app composition with auth. `requireAppUser(event)` returns `{ app, user }`; `resolveAppUserFromRequest` is nullable for WS upgrade paths. |
| `ws-upgrade-auth.ts` | Shared WS upgrade auth returning authenticated or deferred-close contexts. |

Ownership gates live in domains, not in `lib/`: `requireProject workspaceOwner` from
`domains/projects` for project workspace-scoped routes and `requireThreadOwner` from
`domains/threads` for thread routes / thread WS subscriptions. Yjs document
access uses `DocumentAccessPort.canAccessDocument()`.

## WS handlers

| File | Role |
|---|---|
| `ws-thread-handler.ts` | Thread-events WebSocket session: connected frame, subscribe/resume ownership checks, hub catchup/live events, unsubscribe/cleanup. |
| `ws-yjs-handler.ts` | Multiplexed Yjs collaboration handler. One socket can subscribe to many documents; `DocumentAccessPort` gates each document. |
| `ws-safe-send.ts` | Defensive `peer.send` wrapper used for all server-initiated sends. |

## Route helpers / services

| File | One-liner |
|---|---|
| `thread-creation.ts` | Ownership-gated primary thread creation shared by global and project workspace-scoped routes; resolves work attachment and touches the work. |
| `work-attachment.ts` | Determines a new thread's work: explicit `workId`, subagent parent inheritance, or default work for primary threads. |
| `project workspace-preferences-route.ts` | Unit-testable handlers for project workspace preferences GET/PUT. |
| `project workspace-stats.ts` | Pure projection folding thread list + works into `Project workspaceStatsResponse`. |
| `project workspace-results-route.ts` | Ownership-gated project workspace result listing and signed artifact URL refresh. |
| `context-read-route.ts` | Ownership-gated context path resolution. Tracked files return content/schema; binary refs resolve signed object-store URLs. |
| `document-access.ts` | `DocumentAccessPort` interface plus allow-all and Drizzle adapters for Yjs document authorization. |
| `backend-policy.ts` | Small policy helpers for backend selection/guarding. |
| `interrupt-boundary.ts` / `interrupt-error-handler.ts` | HTTP-facing interrupt/error mapping. |
| `startup-guards.ts` / `process-crash-policy.ts` | Boot-time guardrails and process-level crash policy. |

Context ports and runtime tool algorithms live in their owning domains
(`domains/context/*` and `domains/runtime/*`), not in `lib/`. `lib` composes
those pieces into `AppServices` and route/WebSocket entry points.

## Request flow (HTTP)

```
Nitro route handler
  │
  ▼
requireAppUser(event)  → getApp() + Supabase user provisioning
  │
  ▼
Route destructures needed AppServices
  │
  ▼
requireProject workspaceOwner / requireThreadOwner / DocumentAccessPort
  │
  ▼
Domain API call → contract wire shape
```

## Invariants & gotchas

- **One composition root.** Adapter choice belongs in `compose.ts` / small env
  factories called from it. Domains must not import from `lib/`.
- **Explicit required deps.** EventSink, CreditLedger, PermissionGate,
  CheckpointRegistry, and RunTurnPort wiring are explicit; disabled behavior uses
  explicit adapters.
- **One-process hub.** `app.ts` guards `AppServices` on `globalThis`; live hub
  fan-out is process-local even though journal rows are durable.
- **Ownership gate on every route and WS subscribe.** Project workspace/thread gates run
  after auth. Yjs uses `DocumentAccessPort` instead.
- **WS upgrade is accept-then-close.** Nitro dev/httpxy crashes on non-101
  upgrade responses, so rejected upgrades are accepted and then closed with an
  error frame/close code.
- **String(seq) at the HTTP/WS boundary.** Internal journal sequence values are
  bigint; protocol frames stringify them.
- **Object store env-driven.** Local uses filesystem + HMAC signed token URLs;
  S3 uses presigned URLs. `localObjectStore` is `null` in S3 mode.

## Dependency direction

```
lib/*
  │
  ├── depends on: domains/*, @meridian/contracts, @meridian/database
  ├── depends on: Supabase/Nitro/env/provider libraries
  │
  ▼
domains/*  ←  MUST NOT import from lib/
```
