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
│   └── dev-env.ts             active env helpers + database URL resolution
├── __tests__/                 vitest units for dev-mode, portless routes, session identity, etc.
├── bootstrap.ts               pnpm bootstrap: migrate + apply-functions
├── supabase-env.ts            prints local Postgres URL from Supabase CLI status
├── ensure-db.ts               validates/ensures active DATABASE_URL target
├── prepare-db.ts              prepares active database before dev stack startup
├── drop-db.ts                 guarded drop helper for active dev database
├── load-env.ts                root .env loader + requireEnv helper
├── print-worktree-env.ts      helper eval'd by .envrc to expose DATABASE_URL
├── dev-tmux.ts                pnpm dev entrypoint; starts app/server/www through tmux
├── dev-mode.ts                local/tailscale/funnel mode selection
├── portless-routes.ts         portless route definitions and lookup
├── session-identity.ts        worktree slug + tmux session naming
└── tmux-session-store.ts      tmux metadata
```

## Local database/auth contract

Meridian v3 uses Supabase CLI for local Postgres only. Auth is WorkOS AuthKit.

- Start infra with `pnpm supabase:start`.
- Populate `.env` from `.env.example` and `pnpm supabase:env` (DATABASE_URL).
- App schema is Drizzle-owned in `packages/database`, not Supabase migration files.
- `pnpm bootstrap` migrates and applies functions only. Dev identity is provisioned on first dev-login (`ensureUser`); onboarding creates the first project. `WORKOS_DEV_LOGIN_USER_ID` is for e2e lookups.

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
- Keep dev tooling aligned with Supabase CLI + Drizzle + portless.

## Related documentation

- [`DEVELOPMENT.md`](../../DEVELOPMENT.md)
- [`supabase/README.md`](../../supabase/README.md)
- [`packages/database/README.md`](../../packages/database/README.md)
- [`tests/smoke/README.md`](../../tests/smoke/README.md)
