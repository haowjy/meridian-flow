# @meridian/database

Drizzle schema, migrations, functions, and Postgres connection helpers for the Meridian Postgres database (plain `postgres:16` Docker container in dev).

- PL/pgSQL functions live in `src/functions/` and are applied with `pnpm db:apply-functions`.
- Keep provider-specific auth assumptions at the adapter/composition boundary; schema should remain ordinary Postgres where possible.
- Thread-domain usage/cost rollups are persisted columns maintained by
  application repositories/projectors, not database triggers or functions.
- Run `pnpm db:migration-lint` when changing generated SQL.
- Migrations: squashed baseline `0000_thankful_tarantula.sql` (no
  `auth.users` references) plus additive migrations on top
  (`0001_serious_red_skull.sql`, …). `pnpm db:generate` appends the next
  migration.
