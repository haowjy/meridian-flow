# Local Supabase (v3 dev — Postgres only)

Local Postgres for meridian-collab via Supabase CLI. App schema is applied via `packages/database` (Drizzle), not `supabase/migrations`. **Authentication is WorkOS AuthKit** — Supabase GoTrue is not used.

## Prerequisites

- Docker
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)

## Quick start

```bash
pnpm supabase:start          # first run pulls images (~1–2 min)
pnpm supabase:env            # print DATABASE_URL for .env
cp .env.example .env         # then paste DATABASE_URL + WorkOS keys
pnpm bootstrap               # migrate + seed public.users dev row + sample project
```

Studio: http://127.0.0.1:54423  
Postgres: `127.0.0.1:54422`  
*Note: dev apps run via portless at `*.localhost` URLs. These raw ports are for Supabase CLI / psql only.*

## Ports (meridian-collab)

Uses **544xx** so v2 `meridian/backend` Supabase (543xx) can run in parallel.

| Service | Port |
|---------|------|
| API (unused for auth) | 54421 |
| Postgres | 54422 |
| Studio | 54423 |
| Inbucket (email) | 54424 |
| Analytics | 54427 |

## Dev sign-in

Browser and automation use WorkOS AuthKit:

- Manual: sign in via the app login screen (or `WORKOS_DEV_AUTOLOGIN=1` → `/api/auth/dev-login`).
- Server smoke scripts: `apps/server/scripts/workos-dev-session.ts` mints the same sealed `wos-session` cookie.

Configure `WORKOS_*` and `WORKOS_DEV_LOGIN_*` in `.env` (see `.env.example`).

## Design notes

- **`supabase/migrations` is intentionally empty.** App schema is Drizzle in `packages/database` (`config.toml` `[db.migrations] schema_paths=[]`). Do not put app migrations here.
- **Dev user is app-owned.** `pnpm bootstrap` upserts `public.users` with `external_id = WORKOS_DEV_LOGIN_USER_ID` and seeds the default project. First login reconciles via `UserRepository.ensureUser`.
- **DB-backed tests must target a dedicated throwaway DB** (set `RUN_DB_TESTS` + point `DATABASE_URL` at a separate Postgres), not the dev DB. Tests use an isolated fixture identity (dedicated email), NOT `TEST_USER_EMAIL`/`test@meridian.dev`.
