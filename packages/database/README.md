# @meridian/database

Drizzle schema and migrations for the v3 Meridian Postgres database (Docker container in dev: `postgres:16` plus pg_bigm, `tools/postgres/Dockerfile`).

Schema definitions live in [src/schema](src/schema); behavior crossing the schema
and adapters is documented in [the database contract](.context/CONTEXT.md).

## Commands

From repo root. Follow [development setup](../../DEVELOPMENT.md) for the main
`.env` and checkout-scoped database; `db:generate` itself needs no database connection:

```bash
pnpm db:migrate          # install the baseline (refuses a different installed baseline)
pnpm db:generate         # regenerate the baseline from schema and SQL inputs
pnpm db:studio
```

In the main checkout, append `-- --allow-main-database` only when intentionally
targeting its registered database (for example,
`pnpm db:migrate -- --allow-main-database`).

From this package:

```bash
pnpm typecheck
pnpm test   # non-DB tests; use pnpm test:db from the repo root for DB coverage
```

**Fresh clone:** `pnpm dev:infra` → `pnpm bootstrap` (ensure database, then install baseline).

## Auth boundary

- Identity is app-owned **`public.users`** (`external_id` = WorkOS user id).
- `pnpm bootstrap` applies schema only. Dev user row is created on first sign-in; personal project auto-created on first login.
- DB-backed tests must use an **isolated fixture identity** (dedicated email, NOT `TEST_USER_EMAIL`/`test@meridian.dev`) and target a dedicated throwaway DB, never the dev DB.

## Token usage (`model_responses`)

| Column | Role |
|--------|------|
| `input_tokens` / `output_tokens` | Headline totals (queryable) |
| `usage_breakdown` | Nullable JSONB with DB default `'{}'`; omit only when usage is unknown |
| `response_metadata` | Audit metadata from the provider |
| `price_source` | `computed` or `unknown` (usage missing); default `computed` |
| `pricing_snapshot` | JSONB copy of the pricing data used at billing time |

`output_tokens` is total billable output (includes reasoning when known). See `@meridian/contracts` (`UsageBreakdown`, `parseUsageBreakdown`).

## Billing

- **Engine:** `credit_lots` (grant, subscription, purchase, debt), FIFO via `consume_credit_lots_fifo`, balances computed directly from `credit_lots`.
- **Pricing source:** Rates are single-sourced from the gateway's `MODEL_REGISTRY` (see `apps/server/server/domains/runtime/gateway/config/registry.ts`). Every provider uses pinned rates.
- **Idempotency:** `usage_event_id` is **required** (non-empty); enforced in SQL under advisory lock (no unique index — multi-lot debits per turn).
- **Overspend:** remainder goes to a single `source_type = 'debt'` lot per user.
- **User-facing UX (app layer):** show **included usage %** (grant + subscription pool), not raw millicredits. `canStartTurn` = `total_balance_millicredits >= 0`. Overage shown as **>100%** when balance is negative.
- **Tests:** `pnpm test:db` creates owned temporary databases, runs the DB suites and cleans them up. It never uses your dev database as a fixture.

Schema changes before the first deploy with retained data follow [the baseline rule](AGENTS.md).
