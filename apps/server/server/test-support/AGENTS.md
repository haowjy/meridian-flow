# DB test isolation

Use `drizzle-reset.ts` for database isolation. Single-connection suites use
`useRollbackTestDatabase`: read `current` inside hooks/tests and build adapters
from that transaction. Its optional `prepareSuite` establishes the committed
baseline once. Never use the root connection inside a rollback-isolated case.

Suites testing commits, locks, LISTEN/NOTIFY, or multiple connections use
`deleteDrizzleRows(db, anchors)` before each case. Anchors name the tables the
suite owns; the helper drains the shared runtime detached-work tracker, then
follows the live FK graph and deletes dependents first in one transaction.
Include owner tables for insert-only data (prompt bakes are deleted through
their thread). Do not add TRUNCATE or bespoke reset helpers. Runtime harnesses
and manually composed DB-test runtimes use that same tracker; don't create an
isolated tracker that the reset helper cannot drain. Rollback cannot isolate
other connections.

Hoist immutable large fixtures to `beforeAll` only when each case restores its
mutations. Keep query-plan fixtures large enough for their stated plan contract.
Run DB tests through `pnpm test:db`, never against a dev database.

Real transactions do not need real backoff: drive retry delays through the
code's injectable delay and assert the schedule (`context-catalog.ts` is the
pattern). Keep a real clock only when the claim is PostgreSQL's own timing,
such as lock contention. Never poll for work a seed suppressed; await the
notification that proves it ran.
