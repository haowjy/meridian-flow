# @meridian/database

The Drizzle schema, migrations, SQL functions and Postgres connection factory.
No business logic and no ambient transaction context: domain persistence and
transaction propagation live in the server.

## Rules

- The schema stays ordinary Postgres. Identity is the app-owned `public.users`,
  keyed by WorkOS `external_id`; provider-specific auth stays at the adapter
  and composition boundary.
- Schema-shaped DDL comes from `db:generate`; write a migration by hand only for
  behavior Drizzle cannot model. Keep journals and snapshots tracked.
- Until the first deploy with data worth keeping, no stored data is kept. Write a migration
  for empty tables: no backfills, no repairs of old rows, no `NOT VALID` or concurrent
  steps, no readers kept for old shapes; dev data is wiped with `pnpm db:reset`. The
  migration history check still refuses edits to merged migrations, so append one until all
  of them are replaced by one baseline; after that a schema change edits the baseline. The
  first deploy brings back frozen history and migrations written for populated tables.
- `db:migrate` owns migration application and function sync; run the guarded
  `db:apply-functions` alone only when function sync is the whole operation.
  Divergent applied history is a refusal, not a skip.
- Reset only the current checkout's own database.
- Application repositories and projectors maintain rollup columns; the thread
  activity projection is the one trigger-maintained rollup. Triggers on draft
  journal and edit-receipt inserts run inside a writer keystroke's row lock:
  keep them cheap, with JIT off.

Yjs head and checkpoint relationships, immutable edit storage and the trigger
details: [`.context/CONTEXT.md`](.context/CONTEXT.md).
