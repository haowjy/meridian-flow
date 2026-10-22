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

Production uses Postgres. Dev uses a plain `postgres:16` Docker container for
Postgres only; the app schema remains Drizzle-owned in `@meridian/database`.
Auth is WorkOS AuthKit with `public.users` as the identity table.

```bash
pnpm --filter @meridian/database db:migrate
pnpm --filter @meridian/database db:apply-functions
```

Some migrations require every application writer stopped while they run. Their
header comment says so, and `packages/database/.context/CONTEXT.md` explains
why. For those releases: stop all app servers and workers, let open transactions
drain, run both commands above, then start the new release. If a migration fails,
fix the cause and rerun it with writers still stopped; never restart the old
release on a partly migrated schema. Current stop-the-writers ranges: 0075–0081
(draft review conversion) and 0082–0083 (owner handles).

## Environment variables

Production env vars are platform-provided through secrets/env management. There
is no committed production `.env`.

Required baseline:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `WORKOS_API_KEY` | WorkOS API key |
| `WORKOS_CLIENT_ID` | AuthKit client id |
| `WORKOS_COOKIE_PASSWORD` | Sealed session cookie encryption (≥32 chars) |
| `WORKOS_REDIRECT_URI` | AuthKit callback URL registered in WorkOS |
| `MERIDIAN_API_ORIGIN` | Public server/API origin used by app SSR when the app and server are not same-process |
| `APP_ENV` | Set to `production` for production deploys |

Provider-conditioned model variables:

| Variable | When needed |
|---|---|
| `FLOW_ANTHROPIC_API_KEY` | Anthropic model provider |
| `FLOW_OPENAI_API_KEY` | OpenAI model provider |
| `FLOW_DEEPSEEK_API_KEY` | DeepSeek/OpenAI-compatible provider |
| `FLOW_OPENROUTER_API_KEY` | OpenRouter model provider |
| `FLOW_OPENROUTER_BASE_URL` | Optional OpenRouter base URL override |

No external package-execution provider is part of the Meridian Flow v3 deployment contract.
