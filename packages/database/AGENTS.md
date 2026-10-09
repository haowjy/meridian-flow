# @meridian/database

Drizzle schema, migrations, functions, and Postgres connection helpers for the Meridian Postgres database (plain `postgres:16` Docker container in dev).

- PL/pgSQL functions live in `src/functions/`. `pnpm db:migrate` applies them after migrations; `pnpm db:apply-functions` is the guarded standalone sync command.
- Keep provider-specific auth assumptions at the adapter/composition boundary; schema should remain ordinary Postgres where possible.
- Thread-domain usage/cost rollups are persisted columns maintained by
  application repositories/projectors, not database triggers or functions.
- Run `pnpm db:migration-lint` when changing generated SQL. Pre-commit lints
  staged migration SQL; CI runs `drizzle-kit check` plus scoped migration-lint
  (`--strict` only for PRs targeting `main`/`staging`).
- Keep Drizzle `src/migrations/meta/*_snapshot.json` tracked. They are generated
  artifacts and diff-collapsed by `.gitattributes`, but `db:generate` diffs
  against them; a missing snapshot silently corrupts the next migration.
- Schema-representable DDL belongs in migrations produced by `db:generate`.
  Handwritten follow-on migrations contain only database behavior Drizzle cannot
  model, such as trigger functions and triggers; create them with
  `drizzle-kit generate --custom` so the journal remains coherent.
- Migrations: fresh-install baseline `0000_baseline.sql` (no
  `auth.users` references) plus additive migrations listed in
  `src/migrations/meta/_journal.json`. `pnpm db:generate` appends the next
  migration.
- Migrations merged to `main` or `staging` are frozen: never edit, remove,
  renumber, or retimestamp them. After merging the base branch, regenerate this
  branch's unmerged generated migrations from the merged schema so they append
  after the base tip; never renumber or rename them by hand (see
  `.context/CONTEXT.md`). CI enforces this with `pnpm db:migration-history`;
  journal indexes must be contiguous, timestamps strictly increasing, and tags
  and timestamps unique. `db:migrate` refuses divergent applied history rather
  than skipping it.
- Write migrations as if production data exists. Never delete writer data; move
  it. No skips may rely on empty tables. Add CHECKs and FKs `NOT VALID`, then
  `VALIDATE CONSTRAINT` in a later migration. Build and drop indexes
  `CONCURRENTLY` with first-line `-- migration: no-transaction` (BOM and CRLF
  tolerated). Each concurrent statement is alone in its breakpoint chunk.
  Builds use IF NOT EXISTS; the runner pre-drops only invalid indexes they name,
  never valid guards. Use a new permanent replacement name, then drop the old
  guard last. Every statement must be re-runnable. Short lock_timeout settings
  surround only ACCESS EXCLUSIVE statements, not online DDL or validation.
  Reapply these hand-edits to
  generated SQL whenever merging the base requires branch regeneration.
- Existing dev databases from the old chain must be reset with `pnpm db:reset`
  (destroys local data); the new baseline is not an incremental upgrade. Reset
  only the current checkout's own dev database. Shared or deployed resets need
  explicit owner authorization; until launch, a broken deploy may be reset.
  Never reset another developer's database. Legacy imports are a separate ETL.
- `document_yjs_heads.latest_checkpoint_id` is a Drizzle-declared FK, not custom
  SQL. Yjs checkpoints are append-only and disappear only with their parent
  document cascade.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for migration workflow and the
Yjs head FK contract.
