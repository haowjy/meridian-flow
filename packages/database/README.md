# @meridian/database

Drizzle schema and migrations for the v3 Meridian Postgres database (local Supabase in dev).

**Schema spec:** `$MERIDIAN_CONTEXT_KB_DIR/work/v3-fullstack-rebuild/database-schema-v3.md` (or the work item copy under `orange-channel-vale`).

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

## Token usage (`model_responses`)

| Column | Role |
|--------|------|
| `input_tokens` / `output_tokens` | Headline totals (queryable) |
| `usage_breakdown` | Nullable JSONB with DB default `'{}'`; omit only when usage is unknown |
| `response_metadata` | Audit only (request IDs, provider-reported cost) |

`output_tokens` is total billable output (includes reasoning when known). See `@meridian/contracts` (`UsageBreakdown`, `parseUsageBreakdown`).

## Billing

- **Engine:** `credit_lots` (grant, subscription, purchase, debt), FIFO via `consume_credit_lots_fifo`, balances in `credit_balances` view.
- **Idempotency:** `usage_event_id` is **required** (non-empty); enforced in SQL under advisory lock (no unique index — multi-lot debits per turn).
- **Overspend:** remainder goes to a single `source_type = 'debt'` lot per user (never `grant` + `overspend_debt`).
- **User-facing UX (app layer):** show **included usage %** (grant + subscription pool), not raw millicredits. `canStartTurn` = `total_balance_millicredits >= 0`. Overage shown as **>100%** when balance is negative.
- **Tests:** only run against `127.0.0.1:54422` unless `TEST_DB_ALLOW_DESTRUCTIVE=1`.

Canonical function SQL: `src/functions/*.sql`. Migration `0002` embeds the same bodies; `db:apply-functions` keeps dev DB in sync after edits.
