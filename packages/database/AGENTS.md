# @meridian/database

Drizzle schema, migrations, functions, and Postgres connection helpers for the Meridian Postgres database (local Supabase CLI in dev).

- Schema changes live here, not in `supabase/migrations`.
- PL/pgSQL functions live in `src/functions/` and are applied with `pnpm db:apply-functions`.
- Keep provider-specific auth assumptions at the adapter/composition boundary; schema should remain ordinary Postgres where possible.
- Run `pnpm db:migration-lint` when changing generated SQL.
- **Migration-snapshot rot:** the Drizzle meta snapshot chain is stale (0004 vs 12 journal entries) so `pnpm db:generate` is broken. Migrations 0009–0012 were hand-authored. A migration **squash** is the pending fix — do not run `db:generate` until resolved.
