# Architecture — Current Implementation

Meridian Flow v3 is a TypeScript monorepo for a fiction-writing project: a
large-scale chapter editor, project/work context store, Yjs collaboration spine,
and AI runtime that understands narrative context.

## System topology

```
apps/app ──HTTPS/WS──▶ apps/server ──▶ Supabase Postgres + auth.users
   │                         │
   │                         ├── Drizzle app schema
   │                         ├── Yjs document updates
   │                         └── Model providers via runtime/gateway
apps/www
```

Dev is served through portless HTTPS `*.localhost`; do not bypass it with raw
localhost ports for app/server verification.

## Server domain map

The server is a modular monolith under `apps/server/server/`:

```
domains/{billing, collab, context, observability, packages, preferences, projects, runtime, storage, threads}
lib/ plugins/ routes/ shared/
```

`lib/` is the composition root and may wire all domains; domains do not import
`lib/`.

### projects

Owns default project/work bootstrap and project/work persistence. Supabase Auth
credentials are resolved at the HTTP/WS edge and mapped to the internal user id
used by project/thread ownership.

### threads

Owns threads, turns, blocks, model responses, event journal, snapshots, and the
live event hub. Runtime events are projected into read models and appended to
the event journal; the hub maps orchestrator events to AG-UI WebSocket events.

### runtime

Owns the copied upstream-derived orchestrator, model gateway, turn runner,
checkpoint registry, child-run coordinator, tool registry/executor, and runtime
permissions. The active message route calls the turn runner, which starts the
orchestrator and streams through `ThreadEventHub`.

### context + collab

`context` owns URI-addressed writing context and delegates document sync to
`collab`. `collab` owns Yjs updates, markdown projection, and ProseMirror schema
compatibility.

### billing

Credits are user-scoped in the current Meridian schema. The copied runtime port
still accepts project-shaped inputs in places, but the Drizzle adapter ignores
project id and calls the current Postgres FIFO/debt-lot functions.

### preferences

Project preferences are persisted in `project_user_preferences` via the
Drizzle adapter, which is wired as the production surface at the composition
root. The in-memory adapter remains for hermetic tests and local reference
behavior. Both adapters are exported from the domain barrel.

## No external package-execution runtime

The upstream external execution substrate is intentionally excluded. Meridian Flow v3
keeps tool execution as explicit Meridian-owned handlers over project/context
ports, not arbitrary package execution.
