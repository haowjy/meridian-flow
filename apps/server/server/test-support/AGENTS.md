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

Vitest does not cancel a fixture hook when its timeout fires. Do not treat a
longer timeout, delay, or reset mutex as isolation from the still-running hook;
the unresolved fail-stop/tracking work is recorded in `.context/TODO`.
