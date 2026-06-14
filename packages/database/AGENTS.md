# @meridian/database

Drizzle schema, migrations, functions, and Postgres connection helpers for the Supabase-backed Meridian database.

- Schema changes live here, not in `supabase/migrations`.
- PL/pgSQL functions live in `src/functions/` and are applied with `pnpm db:apply-functions`.
- Keep provider-specific auth assumptions at the adapter/composition boundary; schema should remain ordinary Postgres where possible.
- Run `pnpm db:migration-lint` when changing generated SQL.
