# Local Supabase (v3 dev)

Postgres + Auth for meridian-collab. App schema is applied via `packages/database` (Drizzle), not `supabase/migrations`.

## Prerequisites

- Docker
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)

## Quick start

```bash
pnpm supabase:start          # first run pulls images (~1–2 min)
pnpm supabase:env            # print DATABASE_URL and keys for .env
cp .env.example .env         # then paste values from status
pnpm bootstrap               # creates GoTrue-native dev user in auth.users + migrates + seeds
```

Studio: http://127.0.0.1:54423  
API: http://127.0.0.1:54421  
*Note: dev apps run via portless at `*.localhost` URLs. These raw ports are for Supabase CLI / psql only.*

## Ports (meridian-collab)

Uses **544xx** so v2 `meridian/backend` Supabase (543xx) can run in parallel.

| Service | Port |
|---------|------|
| API | 54421 |
| Postgres | 54422 |
| Studio | 54423 |
| Inbucket (email) | 54424 |
| Analytics | 54427 |

## Test login

```bash
source .env
curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_USER_EMAIL\",\"password\":\"$TEST_USER_PASSWORD\"}" | jq -r '.access_token'
```

Use the token as `Authorization: Bearer <token>` against the app server when auth middleware exists.

## Design notes

- **`supabase/migrations` is intentionally empty.** App schema is Drizzle in `packages/database` (`config.toml` `[db.migrations] schema_paths=[]`). Do not put app migrations here.
- **Dev user is GoTrue-native.** `pnpm bootstrap` provisions the dev user through the GoTrue admin API (not a direct `INSERT INTO auth.users`). This produces a real GoTrue-managed user with a random UUID (not the test-fixture `…0111` id).
- **DB-backed tests must target a dedicated throwaway DB** (set `RUN_DB_TESTS` + point `DATABASE_URL` at a separate Postgres), not the dev DB. Tests use an isolated fixture identity (dedicated email), NOT `TEST_USER_EMAIL`/`test@meridian.dev`.
