# @meridian/database

This package owns the Drizzle schema, migrations, SQL functions, and Postgres
connection factory. It has no business logic or ambient transaction context;
domain persistence and transaction propagation live in the server.

## Rules

- Keep provider-specific auth assumptions at the adapter and composition
  boundary; the schema stays ordinary Postgres (identity is the app-owned
  `public.users`, keyed by WorkOS `external_id`).
- Schema-shaped DDL comes from `db:generate`; handwritten migrations are only
  for behavior Drizzle cannot model. Keep journals and snapshots tracked.
- Migrations merged to `main` or `staging` are frozen. Append contiguous,
  strictly timestamped history and regenerate an unmerged lane after a merge;
  never edit, renumber, retimestamp, or remove an applied identity.
- Write migrations for populated tables. Preserve writer data, use `NOT VALID`
  then validation for constraints, and build or drop indexes concurrently in
  re-runnable no-transaction files. Retire columns only after removing readers
  and auditing values; bound ACCESS EXCLUSIVE lock acquisition with a short
  transactional `lock_timeout`.
- `db:migrate` owns migration application and function synchronization. Use the
  guarded standalone function command only when function sync is the explicit
  operation. Divergent applied history is a refusal, not a skip.
- Until launch, do not add expand/contract compatibility shims for the previous
  server version. Reset only the current checkout's own dev database when the
  baseline requires it; legacy imports are a separate ETL.
- Rollup columns are maintained by application repositories/projectors, not
  database triggers, except for the documented thread activity projection.
  Yjs head/checkpoint relationships and immutable edit storage are contracts;
  see [`.context/CONTEXT.md`](.context/CONTEXT.md).
