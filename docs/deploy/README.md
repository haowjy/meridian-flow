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

Production uses Postgres. Dev uses a Docker container built from `tools/postgres/Dockerfile`
(`postgres:16` plus pg_bigm) for
Postgres only; the app schema remains Drizzle-owned in `@meridian/database`.
Auth is WorkOS AuthKit with `public.users` as the identity table.

```bash
pnpm --filter @meridian/database db:migrate
pnpm --filter @meridian/database db:apply-functions
```

### Production Postgres needs the pg_bigm image

Writer project search ([#1173](https://github.com/haowjy/meridian-flow/issues/1173)) indexes
block text with the pg_bigm extension, which stock `postgres:16` and Railway's default Postgres
lack. The release whose migration runs `CREATE EXTENSION pg_bigm` fails on a host without it,
so switch the production Postgres service to an image built from `tools/postgres/Dockerfile`
before that release deploys. Releases before it run on either image.

1. **Back up first.** Take a dump or a platform snapshot of the database you can restore from.
2. **Build and publish the image.** Railway pulls a database image from a registry, so push
   the image built from `tools/postgres/Dockerfile` to one Railway can reach. Per
   [release promotion](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/hosting/release-promotion.md),
   the release pipeline builds that file and promotes it by digest.
3. **Change only the image.** Stay on Postgres 16 and keep the existing data volume. A major
   version change or a new, empty service means a dump and restore instead.
4. **Keep the preload.** The image starts Postgres with `shared_preload_libraries=pg_bigm` on
   its command line, so a data volume with an older `postgresql.conf` still loads it. A start
   command set on the service replaces that flag and has to repeat it.
5. **Check it.** `select name, default_version from pg_available_extensions where name in
   ('pg_bigm', 'btree_gin', 'pg_trgm')` returns all three, and `show shared_preload_libraries`
   includes `pg_bigm`.

Dev and CI already run pg_bigm: dev builds the same Dockerfile (`pnpm dev:infra:upgrade` moves
an existing dev container onto it), and CI installs it on the runner's Postgres.
`pnpm db:check-extensions` checks that an index on it is used.

Some migrations require every application writer stopped while they run. Their
header comment says so, and `packages/database/.context/CONTEXT.md` explains
why. For those releases: stop all app servers and workers, let open transactions
drain, run both commands above, then start the new release. If a migration fails,
fix the cause and rerun it with writers still stopped; never restart the old
release on a partly migrated schema. Current stop-the-writers ranges: 0075–0081
(draft review conversion), 0082–0083 (owner handles) and 0090–0092 (branch
tree ownership).

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
| `FLOW_GEMINI_API_KEY` | Google Gemini provider |
| `FLOW_OPENROUTER_API_KEY` | OpenRouter model provider |
| `FLOW_OPENROUTER_BASE_URL` | Optional OpenRouter base URL override |

No external package-execution provider is part of the Meridian Flow v3 deployment contract.
