# First deploy contract

This folder documents the first deployment shape for Meridian Flow's v3 stack:
`@meridian/app`, `@meridian/server`, and `@meridian/www`.

## Route ownership

| Public route | Owner |
|---|---|
| `/` | app or www, depending on product host |
| `/api/*` | server |
| `/ws/*` | server |

Browser clients should use same-origin relative HTTP/WS paths when an ingress
combines the app and server. Portless dev keeps services on separate
`*.localhost` origins to exercise the real proxy/TLS path.

Reference ingress config: [`nginx.same-origin.example.conf`](./nginx.same-origin.example.conf).

## Build and start commands

```bash
pnpm --filter @meridian/app build
pnpm --filter @meridian/server build
pnpm --filter @meridian/www build
```

Nx `build`, `test`, and `typecheck` targets wrap package scripts for orchestration.

## Database

Production uses Postgres. Dev uses local Supabase for Postgres + `auth.users`;
the app schema remains Drizzle-owned in `@meridian/database`.

```bash
pnpm --filter @meridian/database db:migrate
pnpm --filter @meridian/database db:apply-functions
```

## Environment variables

Production env vars are platform-provided through secrets/env management. There
is no committed production `.env`.

Required baseline:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `SUPABASE_URL` | Supabase Auth API |
| `SUPABASE_ANON_KEY` | Browser/server auth verification |
| `SUPABASE_SERVICE_ROLE_KEY` | Dev/bootstrap/admin-only operations |
| `MERIDIAN_API_ORIGIN` | Public server/API origin used by app SSR when the app and server are not same-process |
| `APP_ENV` | Set to `production` for production deploys |

Provider-conditioned model variables:

| Variable | When needed |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic model provider |
| `OPENAI_API_KEY` | OpenAI model provider |
| `DEEPSEEK_API_KEY` | DeepSeek/OpenAI-compatible provider |

No external package-execution provider is part of the Meridian Flow v3 deployment contract.
