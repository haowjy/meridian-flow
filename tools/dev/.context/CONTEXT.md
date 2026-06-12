# tools/dev — Dev tooling

Local-dev-only utilities. Nothing here is loaded by the application runtime; everything here is invoked by `pnpm` scripts, `.envrc`, or by the developer's shell.

## What this module owns

- **Dev environment resolution** — reading the main checkout's `.env` and applying per-worktree rewrites of every registered DB URL plus the `S3_BUCKET` (object storage)
- **Per-worktree database + bucket administration** — idempotent create (DB + S3 bucket), guarded drop, reserved-name protection
- **`pnpm dev` orchestration** — tmux session management, portless routing, dev-mode selection (local/tailscale/funnel)
- **Bootstrap** — idempotent first-run setup (env file, infra, ensure + migrate schema, seed, portless aliases)
- **Seed + extensions** — dev-data seeding, Postgres extension application

## Directory layout

```
tools/dev/
├── lib/                       deep modules: shared logic; no side effects at import
│   ├── dev-env.ts             DEV_DATABASES registry + per-worktree URL rewrite (uses session-identity)
│   └── dev-db.ts              Postgres admin: parse/validate/ensure/drop/extensions, error mapping
├── __tests__/                 vitest units covering lib/ contracts
│   ├── dev-env.test.ts
│   └── dev-db.test.ts
│
├── prepare-db.ts              pnpm dev:db:prepare → ensure + extensions + migrate, all registered DBs
├── ensure-db.ts               thin CLI: pnpm dev:db:ensure  →  lib/dev-db#ensureDatabaseForUrl (all DBs)
├── drop-db.ts                 thin CLI: pnpm dev:db:drop    →  lib/dev-db#dropDatabaseForUrl (all DBs)
├── print-worktree-env.ts      tsx helper eval'd by .envrc; emits `export VAR=...` for every registered DB
│
├── bootstrap.ts               pnpm bootstrap; uses lib/dev-env + prepare-db
├── seed.ts                    dev-data seed; uses lib/dev-env
│
├── dev-tmux.ts                pnpm dev entrypoint; runs prepare-db before launching tmux
├── dev-mode.ts                local/tailscale/funnel mode selection
├── dev-output.ts              progress logging
├── dev-health.ts              health probes
├── portless-routes.ts         portless route lookup
├── session-identity.ts        worktree slug + session name derivation (used by dev-tmux + lib/dev-env)
├── session-identity.test.ts   ... and many more dev-tool tests
├── tmux-session-store.ts      tmux metadata
└── docker-compose.yml         dev infra (Postgres, MinIO, mailpit)
```

## Per-worktree DB isolation — contracts

The dev tooling guarantees these invariants:

1. **One registry is the source of truth.** `lib/dev-env#DEV_DATABASES` lists every dev database (`DATABASE_URL` → product, `WEB_DATABASE_URL` → web). Env rewrite, ensure, drop, reserved-guard, extensions, and migrate all iterate it — `"web"` is never special-cased elsewhere.
2. **Main checkout sees the bare base names** (`meridian`, `meridian_web`). Determined by `isMainCheckout()` comparing repo root to `git rev-parse --git-common-dir/..`.
3. **Every linked worktree sees `<baseDbName>_<slug>`** per database — slug from `session-identity#resolveSessionIdentity` (branch label + 8-char path hash). Distinct base names (`meridian` vs `meridian_web`) and distinct worktrees can never collide. The rewrite is idempotent.
4. **Product and web are physically separate databases.** The marketing app holds no credential that can reach product data.
5. **Failure to derive a worktree DB is loud, never silent.** `.envrc` aborts when `print-worktree-env.ts` exits non-zero; tools via `applyDevEnvToProcess()` throw.

Consequences:

- The same `pnpm` script from two worktrees touches different databases — no cross-worktree blast radius.
- `bootstrap.ts`, `seed.ts`, `prepare-db.ts`, `ensure-db.ts`, `drop-db.ts` all go through `applyDevEnvToProcess()`; direct `process.loadEnvFile` is forbidden in this module.

## DB admin — contracts

`lib/dev-db.ts` is the only place this module talks SQL admin commands. Contracts:

- `validateDbName` accepts only `^[a-z_][a-z0-9_-]*$` and ≤63 bytes.
- `ensureDatabase` issues `CREATE DATABASE` and treats SQLSTATE `42P04` as success (no SELECT-then-CREATE race).
- `dropDatabase` issues `DROP DATABASE IF EXISTS ... WITH (FORCE)` (Postgres 13+) — kicks live connections; safe during active dev.
- `ensureExtensionsForUrl` creates `CREATE EXTENSION IF NOT EXISTS` for a validated allowlist, connecting to the target DB. Run before migrate (trgm GIN indexes depend on `pg_trgm`).
- `executeSqlForUrl` runs a raw multi-statement SQL script (simple-query protocol, handles plpgsql `$$` bodies) for post-migrate custom SQL (functions/views/triggers in `schema/sql/`); scripts must be idempotent.
- `isReservedDatabase(name, mainDbNames)` returns `true` for `postgres`, `template0`, `template1`, and any main-checkout DB name (resolved from main `.env` via `dev-env#resolveMainDatabaseNames`).
- `formatPgError` maps `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `28P01`, `42501`, `3D000` to actionable hints.

Schema is applied via `drizzle-kit migrate` (committed SQL), not `push`. `drop-db.ts` requires `--yes-i-mean-it` for any reserved DB — the regular `--yes` only bypasses the interactive prompt.

## Composition

```
.envrc
  ├─ dotenv_if_exists <main>/.env             # base DATABASE_URL + WEB_DATABASE_URL
  └─ eval "$(tsx tools/dev/print-worktree-env.ts)"   # rewrite every registered DB via lib/dev-env

pnpm dev (dev-tmux.ts)
  ├─ tsx tools/dev/prepare-db.ts              # ensure + extensions + migrate, all DBs
  └─ tmux orchestration (existing)

pnpm dev:db:prepare (prepare-db.ts)           → ensure + extensions + migrate + post-migrate custom SQL
pnpm dev:db:ensure  (ensure-db.ts)            → lib/dev-db#ensureDatabaseForUrl (all DBs)
pnpm dev:db:drop    (drop-db.ts)              → lib/dev-db#dropDatabaseForUrl (all DBs, reserved-guarded)

pnpm bootstrap (bootstrap.ts)
  ├─ applyDevEnvToProcess()                   # rewrites all registered DB URLs
  ├─ tsx tools/dev/prepare-db.ts              # ensure + extensions + migrate
  └─ ... rest of bootstrap

tsx tools/dev/seed.ts                         # also calls applyDevEnvToProcess()
```

## Conventions

- **Deep modules over shallow.** `lib/dev-env.ts` and `lib/dev-db.ts` are the canonical homes; scripts at the top level are thin CLI wrappers. New DB/env concerns go in `lib/`, not as new top-level scripts.
- **Side effects loud.** Silent fallback to the shared `meridian` DB in a worktree would defeat the isolation guarantee. Helper failures must throw or print and exit non-zero.
- **No direct `.env` parsing outside `lib/dev-env.ts`.** Other tools call `applyDevEnvToProcess()` or `loadMainEnvFile()`.
- **No regex URL surgery.** URL transformations use `new URL()`.
- **Tests guard the contracts.** Slug derivation, URL rewrite edge cases, name validation, and reserved-name guards have vitest coverage in `__tests__/`.

## Related documentation

- [`DEVELOPMENT.md` § Worktree `.env` resolution](../../DEVELOPMENT.md#worktree-env-resolution)
- [`DEVELOPMENT.md` § Per-worktree dev databases](../../DEVELOPMENT.md#per-worktree-dev-databases)
- `session-identity.ts` is the source of truth for worktree slug shape
