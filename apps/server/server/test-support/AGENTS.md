# DB test isolation

DB suites share a worker module cache and an owned database clone. Never export
a live module-level connection or register suite hooks at helper import time.
Each suite creates its own connections and closes them in `afterAll`; shared
helpers accept those connections explicitly. Do not mock modules or process globals.

Use `drizzle-reset.ts` for database isolation. Single-connection suites use
`useRollbackTestDatabase`: read `current` inside hooks/tests and build adapters
from that transaction. The harness drains detached work before rolling back,
while transaction-backed adapters are still usable. Its optional `prepareSuite` establishes the committed
baseline once. Never use the root connection inside a rollback-isolated case.

Suites testing commits, locks, LISTEN/NOTIFY, or multiple connections use
`deleteDrizzleRows(db, anchors)` before each case. Anchors name the tables the
suite owns; the helper drains the shared runtime detached-work tracker, then
follows the live FK graph and deletes dependents first in one transaction.
Include owner tables for insert-only data (prompt bakes are deleted through
their thread). Do not add TRUNCATE or bespoke reset helpers. Runtime harnesses
and manually composed DB-test runtimes use that same tracker; don't create an
isolated tracker that the reset helper cannot drain. Production composition accepts
`backgroundTasks`; DB-test compositions inject `processDetachedWork`. Hocuspocus
room stores enqueue checkpoints: unloading a room does not await that checkpoint,
so checkpoints join the same tracker as repairs and runtime work. Rollback cannot isolate
other connections.

Composed runtimes must unload rooms, shut down background app work, and drain
`documentSync.drainHocuspocusPersistence()` before the next fixture reset. Room
unload schedules checkpoint stores; it does not await their persistence.

Hoist immutable large fixtures to `beforeAll` only when each case restores its
mutations. Keep query-plan fixtures large enough for their stated plan contract.
Run DB tests through `pnpm test:db`, never against a dev database.

Real transactions do not need real backoff: drive retry delays through the
code's injectable delay and assert the schedule (`context-catalog.ts` is the
pattern). Keep a real clock only when the claim is PostgreSQL's own timing,
such as lock contention. Never poll for work a seed suppressed; await the
notification that proves it ran.

The Scratch archival upgrade contract owns an isolated historical schema and
fixed pre-upgrade Yjs inputs (`scratch-archive-fixture.ts`). It applies the
committed migration chain through the real runner, then exercises typed server
consumers. Do not regenerate historical fixture bytes with current writers.

Branch-tree suites build one world per case: `branch-tree-seeds.ts` writes rows the
way the product leaves them (no runtime); `branch-tree-commands.ts` drives the
composed runtime (model replies, the writer's route cores, readers' ports,
review commands: `review` calls the list route core; `apply` and `applyAll`
cover the retained settlement service directly until its replacement (not the
frozen-click HTTP door); `discard` calls the per-document Discard or Discard
all, `purge` deletes the Work, ages it past the cutoff and runs the purge sweep;
readers such as `view(...).text`, `liveMeaning` and `batchStates`);
`branch-tree-scenario.ts` joins the two, and `branch-tree-suite.ts` is the committing
describe block those suites share.
Assert through these verbs (what the writer or a reader sees), not raw tables. Seed only states the
product can't reach yet. Lock races go through `lock-interleave.ts`: `race`
names each run, so an order table reads the same outcome whichever ran first.
