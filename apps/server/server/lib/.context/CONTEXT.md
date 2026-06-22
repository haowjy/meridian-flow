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
| `event-sink-factory.ts` | Env-driven observability adapter factory (`local` stdout + optional JSONL, or no-op). |
| `observability.ts` | Process-scoped deferred EventSink; startup binds the concrete sink before validation/logging. |
| `object-store-factory.ts` | Env-driven object-store adapter factory. |
| `compose.ts` | `AppServices` type, production adapter-port construction, pure runtime service wiring, and in-memory stub factory for tests/dev. |
| `app.ts` | App singleton. `getApp()` caches `AppServices` on `Symbol.for("meridian.app.v1")`, gets the DB/process sink, builds production ports, and calls `composeAppServices()`. |

### Wiring location

Production wiring is split by side-effect boundary:

1. `app.ts` owns the process singleton edge: DB lookup, process EventSink binding/reuse,
   and global hot-reload-safe caching.
2. `createProductionAppPorts()` in `compose.ts` constructs concrete adapters and
   env-driven provider ports: Drizzle repositories, event journal, object store,
   document sync, context port factory, package repository/fetcher/seeder,
   preferences, projects/works/users, billing, model gateway, model-request debug,
   upload/figure/result services, and document access.
3. `composeAppServices()` in `compose.ts` is pure service graph wiring: it builds
   the ThreadEventHub, checkpoint registry, tool registry/executor, late-bound
   turn runner, child-run coordinator, orchestrator, `threadRuntime`, and explicit
   `repos`/`hub` aliases.
4. `createInMemoryAppServices()` is test/dev composition with explicit stubs and
   no-op observability. `hub` and `threadEventHub` are the same object so copied
   route/lib code sees the same alias shape as production.

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
| `eventSink` | observability | Process-scoped deferred sink bound to env-selected local/no-op adapter |
| `packageRepository` | packages | Drizzle package store |
| `preferences` | preferences | Drizzle project preferences repository |
| `orchestrator` | runtime | `RunTurnPort` — the full orchestrator |
| `runner` | runtime | `TurnRunner` with child-run registry |
| `toolRegistry` | runtime | Name-keyed tool registration map |
| `toolExecutor` | runtime | Dispatches tool calls to registered handlers |
| `modelRequestDebug` | runtime | Env-selected model request debug store |

## Tool wiring

`createProductionAppPorts()` constructs the runtime tool registry with `{ db, contextPorts, documentSync, threads, threadWorks }`; `composeAppServices()` wires model-visible tool registrations into the orchestrator stack. The concrete registry currently lives in `domains/runtime/tool-registry.ts`; `lib/` wires it but does not own tool algorithms.

Context-backed handlers resolve the active thread to the unified
`ContextPort` with `resolveThreadContext(...)` + `contextPortForThread(...)`.
Document edits then cross into the collab domain's `@meridian/agent-edit` core;
URI parsing and document-row creation stay server-side so the package remains
free of Meridian URI schemes and database concerns.

| Tool | Backend |
|---|---|
| `write` | Command grammar (`create` / `view` / `insert` / `replace` / `undo` / `redo`). Handler resolves the context URI to a tracked document id, calls `CollabDomain.agentEdit().write(...)`, returns the package's plain-text `WriteResult`, and refreshes the markdown projection after mutating commands. |
| `list` | Lists the resolved unified `ContextPort` path/URI. |
| `search` | Searches the resolved unified `ContextPort` scope. |
| `ask_user` | Creates a checkpoint component block and keeps the assistant turn interruptible/resumable. |

## Auth and ownership

| File | Role |
|---|---|
| `auth.ts` | WorkOS AuthKit authentication seam. `resolveUser(request)` validates the session cookie; `requireUser(request, deps)` provisions/loads the Meridian Flow user row. |
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
requireAppUser(event)  → getApp() + WorkOS/AuthKit user provisioning
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
  ├── depends on: WorkOS AuthKit/Nitro/env/provider libraries
  │
  ▼
domains/*  ←  MUST NOT import from lib/
```
