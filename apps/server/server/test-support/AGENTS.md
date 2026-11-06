# DB test isolation

DB suites share a worker module cache and an owned database clone. Never export
a live module-level connection or register suite hooks at helper import time.
Shared helpers accept connections explicitly. Each suite creates its own
connections and closes them in `afterAll`: `closeTestDatabase` for `Database`
clients, which drains detached work before a bounded pool shutdown, and an
explicit close for bespoke PostgreSQL clients. Do not mock modules or process
globals.

Name suite-owned databases with `disposableTestDatabaseTarget`
(`tools/dev/lib/test-db-lifecycle.ts`). On a managed local run, leave them to the
detached collector instead of dropping inline: PostgreSQL waits for an immediate
checkpoint on every database drop. Unmanaged runs drop inline because they have
no collector.

The server DB setup drains detached work after each case, once file-local
teardown finishes and before suite pool closers run. A file-level drain remains
the backstop before the next file uses that worker. A file `afterAll` that starts
detached DB work must use `closeTestDatabase`.

Use `drizzle-reset.ts` for database isolation. Single-connection suites use
`useRollbackTestDatabase`: read `current` inside hooks and tests, build adapters
from that transaction, and never use the root connection inside a case. Rollback
cannot isolate other connections.

Suites testing commits, locks, LISTEN/NOTIFY, or multiple connections use
`deleteDrizzleRows(db, anchors)` before each case. Anchors name the tables the
suite owns; include owner tables for insert-only data (prompt bakes are deleted
through their thread). Do not add TRUNCATE or bespoke reset helpers.

Runtime harnesses and manually composed DB-test runtimes share the
`processDetachedWork` tracker, because the reset helper cannot drain an isolated
one. Production composition accepts `backgroundTasks`; DB-test compositions
inject `processDetachedWork`. Room unload schedules checkpoint stores without
awaiting them, so checkpoints join the same tracker, and composed runtimes must
unload rooms, shut down background app work, and drain
`documentSync.drainHocuspocusPersistence()` before the next fixture reset.

Collab producers are the exception: each stops and joins its own work through
`collab.lifecycle.dispose`, which a harness awaits before resetting rows, so work
still running cannot deadlock against the reset's locks. Give a collab producer
that escapes it a shutdown of its own rather than also routing it through
`processDetachedWork`, which would leave two owners for one shutdown; see
[collab's CONTEXT.md](../domains/collab/.context/CONTEXT.md).

Hoist immutable large fixtures to `beforeAll` only when each case restores its
mutations. Keep query-plan fixtures large enough for their stated plan contract.

Real transactions do not need real backoff: drive retry delays through the
code's injectable delay and assert the schedule (`context-catalog.ts` is the
pattern). Keep a real clock only when the claim is PostgreSQL's own timing, such
as lock contention. Never poll for work a seed suppressed; await the notification
that proves it ran.

A populated-upgrade proof (seed the old schema, run the new migration, check the
data) runs once, before the migration merges into `main` or `staging`, as a
recipe in `docs/qa/` such as `document-removal-records.md`. After that merge,
`pnpm db:migration-history` refuses any edit to the migration, so no committed
test replays it over populated data. The TypeScript that reads its rows is not
frozen: when a migration leaves old rows in a state new rows never reach, keep a
current-schema DB case that seeds such a row and asserts what the reader returns
(`../domains/threads/adapters/drizzle/turn-position.db.test.ts`).

Branch-tree suites build one world per case: `branch-tree-seeds.ts` writes rows
the way the product leaves them, `branch-tree-commands.ts` drives the composed
runtime, and it has no Apply verb. Assert through these verbs (what the writer or
a reader sees), not raw tables, and seed only states the product can't reach yet.
Lock races go through `lock-interleave.ts`: `race` names each run, so an order
table reads the same outcome whichever ran first, and `waitForPostgresLock` gives
bespoke lock observations one deadline.
