# tools/dev — Agent Rules

Local-dev-only utilities. Never imported by the application runtime.

→ Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

## What this module owns

- Dev env resolution (`.env` loading + per-worktree rewrite of every registered DB URL)
- Per-worktree Postgres DB administration (ensure / drop / extensions / reserved guards)
- Schema application via `drizzle-kit migrate` (`prepare-db.ts`)
- `pnpm dev` orchestration (tmux + portless + dev modes)
- `pnpm bootstrap` and dev-data seeding

## Rules

- **`DEV_DATABASES` (in `lib/dev-env.ts`) is the single source of truth.** To add or change a per-worktree database, edit the registry — never hard-code a second database, env var, or `"web"` special-case in `ensure-db`, `drop-db`, `prepare-db`, `.envrc`, or anywhere else. Every consumer iterates the registry.
- **Use `lib/dev-env.ts` for env loading.** Do not call `process.loadEnvFile` or write a bespoke `loadEnvFromFile`. The canonical entry point is `applyDevEnvToProcess()`.
- **Use `lib/dev-db.ts` for DB admin.** Do not open a fresh `pg.Client` and run `CREATE`/`DROP`/`CREATE EXTENSION` from a new script — extend the helpers in `lib/dev-db.ts` and add a thin CLI wrapper.
- **No regex URL surgery.** Transformations on a database URL use `new URL()` and rewrite `pathname` specifically. The worktree name is always `<baseDbName>_<slug>` (derived from the URL's own base name), and the rewrite must stay idempotent.
- **Silent fallback is forbidden in worktree mode.** If a tool cannot derive the worktree-scoped DB, it must throw/exit loudly. Silent fallback to a shared DB would re-introduce the cross-worktree blast radius.
- **`drop-db` must always go through `isReservedDatabase`** against the full set of main-checkout DB names. New "main-like" databases get protected by extending `RESERVED_DATABASES` in `lib/dev-db.ts` (or the registry), not by patching the CLI.
- **Schema changes use `generate` + `migrate`, not `push`.** `dev`/`bootstrap` apply committed migrations via `prepare-db.ts`; `db:push` is for disposable local experiments only and never carries `--force`.
- **New DB-shape contracts get tests.** Slug-rewrite, name-validation, idempotency, and reserved-name behavior are covered by `__tests__/dev-env.test.ts` and `__tests__/dev-db.test.ts`. Add cases when you change those contracts.

## Do not

- Do not run `tools/dev/*` scripts from production code or app runtime
- Do not import from `apps/`, `packages/`, or `python/` — these are dev tools, not app code
- Do not depend on Node modules outside the root `package.json`'s devDependencies
