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
pnpm bootstrap               # create test@meridian.dev in auth.users
```

Studio: http://127.0.0.1:54423  
API: http://127.0.0.1:54421

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
