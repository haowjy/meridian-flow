# @meridian/database

Drizzle schema and migrations for the v3 Meridian Postgres database (plain `postgres:16` Docker container in dev).

**Schema spec:** v3-fullstack-rebuild work dir `schema/` + `specs/` (see `meridian work current`; repo mirror at `.meridian/context/orange-channel-vale/work/v3-fullstack-rebuild/`).

## Commands

From repo root (requires `.env` with `DATABASE_URL`, port **54422** for local Postgres):

```bash
pnpm db:migrate          # apply pending migrations
pnpm db:apply-functions  # transactionally sync PL/pgSQL from src/functions/
pnpm --filter @meridian/database build:release # self-contained deploy release bundle
pnpm db:generate         # drizzle-kit generate (review output)
pnpm db:studio
```

From this package:

```bash
pnpm typecheck
pnpm test   # integration tests; needs DATABASE_URL + TEST_USER_ID
```

**Fresh clone:** `pnpm dev:infra` → `pnpm bootstrap` (migrate + apply-functions).

Deploy images run `pnpm --filter @meridian/database build:release` at build
time and invoke `node dist/release/release.mjs` as Railway's pre-deploy
command. If migrations are pending, it requires a deploy-seam confirmation in
`MERIDIAN_BACKUP_REF` (`<provider>:<backup id>:release=<sha>`) whose release
SHA matches `MERIDIAN_RELEASE_SHA`; then it applies migrations and function SQL
in one transaction. Snapshot creation is owned by `tools/deploy/deploy.ts`, so
the Neon credential never reaches the Railway runtime. With no pending
migrations, no backup confirmation is required. The bundle needs Node at
runtime, but no `node_modules`.

The release command requires `DATABASE_URL`; `MERIDIAN_RELEASE_SHA` defaults to
`unknown`. Pending migrations are refused unless `MERIDIAN_BACKUP_REF` confirms
a pre-migration backup for that exact release. Local development can explicitly
use `--no-backup-check` with `APP_ENV=dev`, `development`, or `local`; the
image's default command must not use that escape hatch.

The release bundle contains migration SQL, `meta/_journal.json`, and canonical
function SQL only; Drizzle snapshot JSON is build-time metadata and is not read
by the release runner. `getSchemaStatus` uses the same journal parsing and
ledger comparison as the release runner. A matching prefix that is shorter
than the image is `behind`, a mismatched history is `divergent`, and a database
ahead of the image remains a valid rollback target. Server `/readyz` uses this
check to keep a new image unhealthy until its schema is ready.

`assertSupportedDatabaseUrl` is shared by server startup guards and the release
CLI. Remove `channel_binding` from `DATABASE_URL` (retain `sslmode=require`);
postgres.js does not support it. Staging and production also require a Neon
direct endpoint rather than a `-pooler` host because the server uses LISTEN.

## Auth boundary

- Identity is app-owned **`public.users`** (`external_id` = WorkOS user id).
- `pnpm bootstrap` applies schema only. Dev user row is created on first sign-in; personal project auto-created on first login.
- DB-backed tests must use an **isolated fixture identity** (dedicated email, NOT `TEST_USER_EMAIL`/`test@meridian.dev`) and target a dedicated throwaway DB, never the dev DB.

## Token usage (`model_responses`)

| Column | Role |
|--------|------|
| `input_tokens` / `output_tokens` | Headline totals (queryable) |
| `usage_breakdown` | Nullable JSONB with DB default `'{}'`; omit only when usage is unknown |
| `response_metadata` | Audit only (request IDs, provider-reported cost) |
| `provider_request_id` | OpenRouter generation ID / provider request ID for cost reconciliation |
| `price_source` | `"pinned"` (direct provider) or `"provider"` (OpenRouter reported) |
| `pricing_snapshot` | JSONB copy of the pricing data used at billing time |

`output_tokens` is total billable output (includes reasoning when known). See `@meridian/contracts` (`UsageBreakdown`, `parseUsageBreakdown`).

## Billing

- **Engine:** `credit_lots` (grant, subscription, purchase, debt), FIFO via `consume_credit_lots_fifo`, balances computed directly from `credit_lots`.
- **Pricing source:** Rates are single-sourced from the gateway's `MODEL_REGISTRY` (see `apps/server/server/domains/runtime/gateway/config/registry.ts`). The flat `MODEL_TOKEN_RATES` table is **deleted**. Direct providers use pinned rates; OpenRouter uses provider-reported cost.
- **Idempotency:** `usage_event_id` is **required** (non-empty); enforced in SQL under advisory lock (no unique index — multi-lot debits per turn).
- **Overspend:** remainder goes to a single `source_type = 'debt'` lot per user (never `grant` + `overspend_debt`).
- **User-facing UX (app layer):** show **included usage %** (grant + subscription pool), not raw millicredits. `canStartTurn` = `total_balance_millicredits >= 0`. Overage shown as **>100%** when balance is negative.
- **Tests:** only run against `127.0.0.1:54422` unless `TEST_DB_ALLOW_DESTRUCTIVE=1`.

Canonical function SQL: `src/functions/*.sql`. The initial migration creates the functions and triggers; `db:apply-functions` keeps dev DB functions in sync after edits.
