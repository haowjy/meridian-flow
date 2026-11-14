# DB test isolation

DB suites share a worker module cache and an owned database clone. Depth:
[.context/CONTEXT.md](.context/CONTEXT.md).

- Never export a live module-level connection or register suite hooks at helper
  import time. Shared helpers accept connections explicitly; each suite creates its
  own and closes them in `afterAll`: `closeTestDatabase` for `Database` clients (it
  drains detached work before a bounded pool shutdown), an explicit close for
  bespoke PostgreSQL clients. Do not mock modules or process globals.
- Name suite-owned databases with `disposableTestDatabaseTarget`
  (`tools/dev/lib/test-db-lifecycle.ts`). On a managed local run leave them to the
  detached collector: every inline drop waits for a PostgreSQL checkpoint.
  Unmanaged runs drop inline.
- Isolate with `drizzle-reset.ts`. Single-connection suites use
  `useRollbackTestDatabase`: read `current` inside hooks and tests, build adapters
  from that transaction, never use the root connection inside a case. Rollback
  cannot isolate other connections.
- Suites testing commits, locks, LISTEN/NOTIFY or multiple connections call
  `deleteDrizzleRows(db, anchors)` before each case. Anchors name the tables the
  suite owns, plus owner tables for insert-only data (prompt bakes are deleted
  through their thread). Add no TRUNCATE or bespoke reset helper.
- Detached work: runtime harnesses and manually composed DB-test runtimes inject
  the shared `processDetachedWork` tracker; production passes `backgroundTasks`.
  Before the next fixture reset a composed runtime must unload rooms, shut down
  background app work and drain `documentSync.drainHocuspocusPersistence()`. A
  collab producer is the exception: it stops through `collab.lifecycle.dispose`,
  and one that escapes it gets its own shutdown, not a second owner in
  `processDetachedWork`.
- Drive retry delays through the code's injectable delay and assert the schedule
  ; keep a real clock only when the claim is
  PostgreSQL's own timing. Never poll for work a seed suppressed; await the
  notification that proves it ran.
- Hoist an immutable large fixture to `beforeAll` only when each case restores its
  mutations. Keep query-plan fixtures large enough for their stated plan contract.
- Before the first deploy, fixtures use the current baseline. Do not replay
  retired migrations or keep fixtures for data no current writer can create.
