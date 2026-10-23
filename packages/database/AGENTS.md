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
- Migrations merged to `main` or `staging` are frozen. Append contiguous,
  strictly timestamped history and regenerate an unmerged branch's migration
  after a merge; never edit, renumber, retimestamp or remove an applied
  identity.
- Write migrations for populated tables: preserve writer data, add constraints
  `NOT VALID` then validate, build or drop indexes concurrently in re-runnable
  no-transaction files, retire columns only after removing readers and
  auditing values, and bound ACCESS EXCLUSIVE lock acquisition with a short
  transactional `lock_timeout`.
- `db:migrate` owns migration application and function sync; run the guarded
  `db:apply-functions` alone only when function sync is the whole operation.
  Divergent applied history is a refusal, not a skip.
- Before launch, resetting a dev database is a standing option. Reset only the
  current checkout's own database.
- Application repositories and projectors maintain rollup columns; the thread
  activity projection is the one trigger-maintained rollup. Triggers on draft
  journal and edit-receipt inserts run inside a writer keystroke's row lock:
  keep them cheap, with JIT off.

Yjs head and checkpoint relationships, immutable edit storage and the trigger
details: [`.context/CONTEXT.md`](.context/CONTEXT.md).
