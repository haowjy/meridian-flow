# tools/dev — Dev tooling

Local-dev-only utilities. Not loaded by the application runtime.

**Onboarding:** [DEVELOPMENT.md](../../DEVELOPMENT.md). **Rules when editing this module:** [AGENTS.md](../AGENTS.md).

## What this module owns

- **Environment resolution** — `lib/dev-env.ts` (`DEV_DATABASES`, worktree URL rewrite, `applyDevEnvToProcess`, `ensureDirenvAllowed`)
- **Database admin** — `lib/dev-db.ts` (ensure/create/drop/reset against local Postgres)
- **Infra lifecycle** — `lib/dev-infra.ts` + `docker-compose.yml` (`postgres:16` on `:54422`)
- **Schema application** — `bootstrap.ts`, `prepare-db.ts` (migrate + `db:apply-functions`)
- **Dev orchestration** — `dev-tmux.ts` (worktree-scoped tmux + portless routes)

## Directory layout

```
tools/dev/
├── lib/
│   ├── dev-env.ts             DEV_DATABASES registry + worktree URL rewrite
│   ├── dev-db.ts              CREATE/DROP/EXTENSION admin
│   └── dev-infra.ts           docker compose lifecycle
├── docker-compose.yml
├── bootstrap.ts               pnpm bootstrap
├── ensure-db.ts / prepare-db.ts / drop-db.ts / reset-db.ts
├── print-worktree-env.ts      eval'd by .envrc
├── dev-tmux.ts                pnpm dev
├── portless-routes.ts / dev-mode.ts / session-identity.ts
└── migration-lint.ts
```

## Environment contract

- **`DEV_DATABASES`** (`lib/dev-env.ts`) is the single registry — consumers iterate it; never hard-code a second DB env var.
- Main-checkout **`.env`** is loaded via `loadMainEnvFile`; linked worktrees rewrite registered URLs to `<baseDbName>_<slug>` (idempotent; no silent fallback to shared `meridian`).
- **`.envrc`** → `print-worktree-env.ts`; **`applyDevEnvToProcess`** applies the same rewrite for pnpm scripts.

## Database contract

- One Postgres server (`:54422`), many databases. Main checkout: **`meridian`** (reserved). Worktrees: **`meridian_<slug>`**.
- **`drop-db`** refuses reserved/main-checkout names. Use **`db:reset`** (schema-only) rather than dropping `meridian`.
- **Reset:** `db:reset` — drop/recreate `public` + `drizzle` on the active DB, then `prepare-db`.
- **Full wipe:** `dev:infra:down`, remove `meridian-dev_meridian-postgres-data` volume, `bootstrap`.

## Dev server contract

- Portless-first — `pnpm portless:list` is the URL source of truth; no raw localhost port assumptions in new dev tools.
- `pnpm dev` → worktree-scoped tmux session; `--stop` / `--restart` clean only this worktree's session and orphaned routes.
- Smoke/e2e should use portless/TLS routes unless intentionally in-process.

## Migration tooling

`migration-lint.ts` scans generated Drizzle SQL for risky production patterns (renames, drops, unsafe `SET NOT NULL`, etc.). Warnings are non-blocking; errors block.

## Conventions

- Top-level scripts stay thin; reusable logic in `lib/`.
- URL transforms use `new URL()` — no regex surgery on connection strings.
- Explicit errors over silent fallback.
- Provider assumptions stay in dev tooling, not domain code.

## Related documentation

- [`DEVELOPMENT.md`](../../DEVELOPMENT.md) — env, worktrees, hooks, command reference
- [`packages/database/README.md`](../../packages/database/README.md)
- [`tests/smoke/README.md`](../../tests/smoke/README.md)
