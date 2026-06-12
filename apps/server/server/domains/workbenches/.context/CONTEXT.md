# domains/workbenches — Workbenches & Works

Persistence and ownership for the two foundational data containers a thread
hangs off of. Split out of the former `domains/content` grab-bag.

## What it owns

- **Workbenches** — the top-level research-effort container (CRUD, soft-delete).
- **Works** — a unit of work grouping one or more primary threads under a
  workbench (`Thread.workId` is a nullable FK; `null` = ungrouped).
- **Access checks** — `requireWorkbenchOwner` gates every workbench-scoped route.
- **User provisioning** — idempotent external credential upsert into `users`
  before any FK-backed user write; returns Meridian's internal user id.

## Contracts (ports)

| Port | Verbs |
|---|---|
| `WorkbenchRepository` | `create / findById / listByUser / search / update / softDelete / restore / touch` |
| `WorkRepository` | `create / findById / listByWorkbench / ensureDefaultForWorkbench / touch` |
| `UserRepository` | `ensureUser` (external credential → internal user id) |
| `requireWorkbenchOwner(repos, workbenchId, userId)` | returns `Workbench` or throws 404 |

Entity types (`Workbench`, `Work`) are JSON-natural and live in
`@meridian/contracts`. Writes take `Create*Input` structs; reads return entities.

## Adapters

Workbench and work repos have `drizzle` (production) and `in-memory` (test/dev)
adapters behind shared `__conformance__` suites. `UserRepository` has matching
Drizzle/in-memory adapters and only exposes the idempotent `ensureUser` command
because auth owns the source profile shape.

## Invariants & known gaps

- Soft-delete is via `deletedAt`; `softDelete`/`restore` are idempotent.
- `requireWorkbenchOwner` returns 404 (not 403) on both missing and not-owned, to
  avoid leaking existence.
- Auth entry points all flow through `server/lib/auth-gate.ts`:
  `requireAppUser(event)` for HTTP routes and `resolveAppUserFromRequest(request)`
  (nullable) / `requireAppUserFromRequest(request)` for WebSocket upgrades. These
  provision the `users` row from the Supabase credential and carry the internal
  `users.id` UUID as the downstream authorization principal.
- Default-work creation converges under concurrency: the database enforces one
  active, non-deleted default work per workbench via the partial unique index in
  `packages/database/src/schema/works.ts:51-55`, and the Drizzle adapter inserts
  with `onConflictDoNothing` before re-reading the winning row.
- `touch()` is called from message send (`workbenchRepo.touch`) and thread creation
  (`workRepo.touch`), keeping recent workbench/work ordering tied to runtime activity.

## Wiring

Constructed in `lib/compose.ts` (`workbenchRepo`, `users`, `workRepo`); the
default-work attachment policy lives in `lib/work-attachment.ts` +
`lib/thread-creation.ts`.
