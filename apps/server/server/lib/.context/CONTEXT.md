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
| `compose.ts` | DI composition root. Splits pure wiring from production adapter construction. |
| `app.ts` | App singleton. `getApp()` caches `AppServices` on `Symbol.for("meridian.app.v1")` and calls `getDb()` / `getModelGateway()` / event sink setup / `createProductionAppPorts()` / `composeAppServices()`. |

### `compose.ts` split

**`composeAppServices(ports)`** — pure wiring, no env reads and no adapter
construction. It assembles the hub, checkpoint registry, tool registry/executor,
late-bound `RunTurnPort`, turn runner, child-run coordinator, spawn tools,
explicit `PermissionGate` (`coding` profile), orchestrator, upload import
service, input-ingest and promotion factories, and the returned `AppServices`.

**`createProductionAppPorts(options)`** — constructs Drizzle/postgres-backed and
env-backed adapters from already-parsed inputs: projects/works/users,
threads/journal, collab document sync, context port factory, document access,
figure assets, results, credit ledger, and default package seeder.

**`createInMemoryAppServices(options)`** — test/dev composition. It creates
in-memory repositories/adapters, requires an injected gateway and event sink, and
then calls the same `composeAppServices()` pure-wiring path.

The late-bind `RunTurnPort` exists because the turn runner and child-run
coordinator need a run-turn port before the orchestrator can be fully
constructed; `composeAppServices()` creates the proxy, wires dependents, creates
the orchestrator, then binds the proxy.

## Tool wiring

`wired-core-tools.ts` supplies concrete handlers to the runtime domain's core
tool catalogue and returns runnable core registrations. Core tool algorithms
live in `domains/runtime/tools/core-handlers/`; `lib/` only closes over adapters
and domain services.

Context-backed handlers resolve a **ContextPort** per thread via
`ContextPortFactory.forProject workspace(thread.project workspaceId, thread.userId)`.

| Tool | Backend |
|---|---|
| `read` | `ContextPort.read(uri)` → content with line numbers + truncation marker. |
| `edit` | `ContextPort.read` → edit ranges → `ContextPort.write` with agent provenance. |
| `write` | `ContextPort.write(uri, content)` with agent provenance. |
| `list` | `ContextPort.list(uri)`. |
| `search` | `ContextPort.search(query, uri?)`. |
| `ask_user` | Checkpoint component block + same-turn suspend/resume. |

Tool registrations carry `source` and at most one privileged `capability`; the
runtime registry throws on duplicate names. Skill slugs that collide with
non-skill tools are not rebound and emit `skill_tool.name_collision`.

## Auth and ownership

| File | Role |
|---|---|
| `auth.ts` | Supabase authentication seam. `resolveUser(request)` validates the session cookie; `requireUser(request, deps)` provisions/loads the Meridian user row. |
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

Uploads, context-port factories, promotion flush factories, and core tool
algorithms live in their owning domains (`domains/context/*` and
`domains/runtime/tools/core-handlers/*`), not in `lib/`.

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
