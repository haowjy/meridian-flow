# @meridian/database

The Drizzle schema, baseline SQL and Postgres connection factory. Domain persistence
and transaction propagation live in the server, not here.

## Before the first deploy with retained data

- There is one migration: `src/migrations/0000_baseline.sql`. Edit
  `src/schema/` and regenerate with `pnpm db:generate`; never edit generated SQL,
  its journal or snapshot by hand. SQL Drizzle cannot model lives in
  `src/schema/sql/`; reusable function definitions live in `src/functions/`.
  The generator includes both in the baseline.
- When parallel branches change the schema, resolve the schema files, discard
  conflicts in the three generated migration files, and run `pnpm db:generate`
  again. Do not combine migration SQL. A second generation must leave no diff.
- Run `pnpm db:reset` to wipe and rebuild this checkout's dev database.
  Clear this app origin's browser storage too: old IndexedDB state can restore
  documents from before the reset. Never reset another checkout or a deployment.
- At the first deploy with data worth keeping, freeze the baseline and restore
  append-only migration generation, history checks and populated-table migration
  lint before the next schema change.

Identity is app-owned `public.users`, keyed by WorkOS `external_id`.
Provider-specific auth stays at the adapter and composition boundary.
Application repositories maintain rollups except for thread activity, which is
trigger-maintained.

Yjs storage, immutable receipts and other contracts:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
