# @meridian/database

Drizzle schema, migrations, functions, and Postgres connection helpers for the Meridian Postgres database (plain `postgres:16` Docker container in dev).

- PL/pgSQL functions live in `src/functions/` and are applied with `pnpm db:apply-functions`.
- Keep provider-specific auth assumptions at the adapter/composition boundary; schema should remain ordinary Postgres where possible.
- Thread-domain usage/cost rollups are persisted columns maintained by
  application repositories/projectors, not database triggers or functions.
- Run `pnpm db:migration-lint` when changing generated SQL. Pre-commit lints
  staged migration SQL; CI runs `drizzle-kit check` plus scoped migration-lint
  (`--strict` only for PRs targeting `main`/`staging`).
- Keep Drizzle `src/migrations/meta/*_snapshot.json` tracked. They are generated
  artifacts and diff-collapsed by `.gitattributes`, but `db:generate` diffs
  against them; a missing snapshot silently corrupts the next migration.
- Migrations: squashed baseline `0000_thankful_tarantula.sql` (no
  `auth.users` references) plus additive migrations listed in
  `src/migrations/meta/_journal.json`. `pnpm db:generate` appends the next
  migration.
- `document_yjs_heads.latest_checkpoint_id` is a Drizzle-declared FK, not custom
  SQL. Yjs checkpoints are append-only and disappear only with their parent
  document cascade.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for migration workflow, Yjs head
FK contract, and schema map.
