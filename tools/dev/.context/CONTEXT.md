# tools/dev — Dev tooling

Local-dev-only utilities. Nothing here is loaded by the application runtime; tools are invoked by `pnpm` scripts, `.envrc`, or a developer shell.

## What this module owns

- **Environment loading** — `load-env.ts` reads root `.env` and reports missing required keys with setup guidance.
- **Database readiness** — thin CLIs for ensuring, preparing, and dropping the active Postgres database URL used by this worktree.
- **Drizzle schema application** — bootstrap runs migrations and applies PL/pgSQL functions from `@meridian/database`.
- **Dev orchestration** — `dev-tmux.ts` starts the worktree-scoped tmux stack and portless routes; `dev-mode.ts` selects local/tailscale/funnel exposure modes.
- **Portless route helpers** — `portless-routes.ts` and app e2e helpers discover the HTTPS `*.meridian.localhost` routes used in development.

## Directory layout

```
tools/dev/
├── lib/
│   ├── dev-env.ts             active env helpers + database URL resolution
│   ├── dev-db.ts              CREATE/DROP/EXTENSION admin against local Postgres
│   └── dev-infra.ts           docker compose lifecycle for postgres:16
├── docker-compose.yml         local postgres:16 on host port 54422
├── __tests__/                 vitest units for dev-mode, portless routes, session identity, etc.
├── bootstrap.ts               pnpm bootstrap: migrate + apply-functions
├── ensure-db.ts               validates/ensures active DATABASE_URL target
├── prepare-db.ts              prepares active database before dev stack startup
├── drop-db.ts                 guarded drop helper for active dev database
├── reset-db.ts                schema reset (public + drizzle) + prepare-db
├── load-env.ts                root .env loader + requireEnv helper
├── print-worktree-env.ts      helper eval'd by .envrc to expose DATABASE_URL
├── dev-tmux.ts                pnpm dev entrypoint; starts app/server/www through tmux
├── dev-mode.ts                local/tailscale/funnel mode selection
├── portless-routes.ts         portless route definitions and lookup
├── session-identity.ts        worktree slug + tmux session naming
└── tmux-session-store.ts      tmux metadata
```

## Local database/auth contract

Meridian v3 uses a plain `postgres:16` Docker container for local Postgres. Auth is WorkOS AuthKit.

- Start infra with `pnpm dev:infra`.
- Set `DATABASE_URL` in `.env` (see `.env.example`).
- App schema is Drizzle-owned in `packages/database`.
- `pnpm bootstrap` migrates and applies functions only. Dev identity is provisioned on first dev-login (`ensureUser`); onboarding creates the first project. `WORKOS_DEV_LOGIN_USER_ID` is for e2e lookups.

### Reset vs full wipe

Worktrees share one dev database (`meridian`). `drop-db` refuses reserved/main-checkout DB names — that guard stays; use schema reset instead of `DROP DATABASE`.

- **Reset schema (normal):** `pnpm db:reset` — ensures Docker Postgres is up, drops/recreates `public`, drops `drizzle` (migration journal), then runs `prepare-db` (extensions + migrate + apply-functions).
- **Full wipe:** `pnpm dev:infra:down`, remove the `meridian-dev_meridian-postgres-data` Docker volume, then `pnpm bootstrap`.

## Dev server contract

Development is portless-first.

- `pnpm dev` runs the stack through a worktree-scoped tmux session.
- `pnpm portless:list` is the source of truth for live HTTPS app/server/www URLs.
- Tests and smoke scripts should go through portless/TLS routes unless they intentionally start an isolated in-process smoke server.
- Do not add raw localhost port assumptions to new dev tools.

## Migration tooling

`migration-lint.ts` is a warning-first SQL scanner for generated Drizzle migrations. It flags risky deployed-Postgres patterns such as column renames, drops, unsafe `SET NOT NULL`, foreign keys without `NOT VALID`, blocking index creation, and unconstrained deletes.

Run:

```bash
pnpm db:migration-lint
```

Warnings do not currently block the pipeline; errors do.

## Conventions

- Keep top-level scripts thin; put reusable logic in helpers.
- Keep local infrastructure provider assumptions in dev tooling and composition roots, not domain code.
- Use `new URL()` for URL transformations.
- Prefer explicit setup errors over silent fallback.
- Keep dev tooling aligned with Docker Postgres + Drizzle + portless.

## Related documentation

- [`DEVELOPMENT.md`](../../DEVELOPMENT.md)
- [`packages/database/README.md`](../../packages/database/README.md)
- [`tests/smoke/README.md`](../../tests/smoke/README.md)
