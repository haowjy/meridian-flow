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
command. It verifies an S3-compatible custom-format backup before applying
pending migrations and function SQL in the same transaction. The bundle needs
Node and `pg_dump` at runtime, but no `node_modules`.

The release command requires `DATABASE_URL`, `BACKUP_S3_BUCKET`,
`BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`, and
`BACKUP_S3_SECRET_KEY`. `BACKUP_S3_FORCE_PATH_STYLE` defaults to `true`,
`BACKUP_S3_PREFIX` defaults to `backups/<APP_ENV or unknown>`, and
`MERIDIAN_RELEASE_SHA` defaults to `unknown`. `backup` runs only the backup;
`migrate` also backs up unless explicitly passed `--no-backup`.

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
