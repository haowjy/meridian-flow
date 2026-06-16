# @meridian/database

Drizzle schema and migrations for the v3 Meridian Postgres database (local Supabase in dev).

**Schema spec:** v3-fullstack-rebuild work dir `schema/` + `specs/` (see `meridian work current`; repo mirror at `.meridian/context/orange-channel-vale/work/v3-fullstack-rebuild/`).

## Commands

From repo root (requires `.env` with `DATABASE_URL`, port **54422** for collab Supabase):

```bash
pnpm db:migrate          # apply pending migrations
pnpm db:apply-functions  # sync PL/pgSQL from src/functions/ (after migrate in dev)
pnpm db:generate         # drizzle-kit generate (review output)
pnpm db:studio
```

From this package:

```bash
pnpm typecheck
pnpm test   # integration tests; needs DATABASE_URL + TEST_USER_ID
```

**Fresh clone:** `pnpm supabase:start` → `pnpm bootstrap` (runs migrate + apply-functions + seed).

## Auth boundary

- `auth.users` is **Supabase-managed**. Drizzle defines a minimal `auth.users` stub in TypeScript for FK typing only.
- Kit entry: `src/schema/drizzle.ts` (public tables). Runtime client uses `src/schema/index.ts` (includes `authUsers`).
- Migrations must **not** `CREATE` or `ALTER` `auth.users`. `drizzle.config.ts` uses `schemaFilter: ['public']`.
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

- **Engine:** `credit_lots` (grant, subscription, purchase, debt), FIFO via `consume_credit_lots_fifo`, balances in `credit_balances` view.
- **Pricing source:** Rates are single-sourced from the gateway's `MODEL_REGISTRY` (see `apps/server/server/domains/runtime/gateway/config/registry.ts`). The flat `MODEL_TOKEN_RATES` table is **deleted**. Direct providers use pinned rates; OpenRouter uses provider-reported cost.
- **Idempotency:** `usage_event_id` is **required** (non-empty); enforced in SQL under advisory lock (no unique index — multi-lot debits per turn).
- **Overspend:** remainder goes to a single `source_type = 'debt'` lot per user (never `grant` + `overspend_debt`).
- **User-facing UX (app layer):** show **included usage %** (grant + subscription pool), not raw millicredits. `canStartTurn` = `total_balance_millicredits >= 0`. Overage shown as **>100%** when balance is negative.
- **Tests:** only run against `127.0.0.1:54422` unless `TEST_DB_ALLOW_DESTRUCTIVE=1`.

Canonical function SQL: `src/functions/*.sql`. The initial migration creates the functions and triggers; `db:apply-functions` keeps dev DB functions in sync after edits.
