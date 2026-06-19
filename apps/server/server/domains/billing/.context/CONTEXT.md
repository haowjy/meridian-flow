# domains/billing — credit ledger & pricing (registry-sourced)

Owns the credit lot model (canonical balance truth), the `CreditLedger` port,
and model-call pricing conversions. Rates are single-sourced from the gateway's
`MODEL_REGISTRY` — the flat `MODEL_TOKEN_RATES` table is **deleted**.

## What it owns

- **Credit ledger port** — `grant`, `debit` (FIFO lot consumption with
  usage-event idempotency), `getBalance`, and per-run/per-agent/per-thread
  debit total queries.
- **Pricing** — `PinnedModelRate` (gateway-local type, imported from gateway's
  `registry.ts`), `createLayeredTokenRateSource` (pinned + fallback layers),
  `computeModelCost` for converting token usage to USD and millicredits.
- **Domain types** — `CreditGrantInput`, `CreditDebitInput`, `CreditLedger`
  interface.
- **Provider-reported cost (OpenRouter)** — passed through as
  `priceSource: "provider"` with `pricingSnapshot` on `model_responses`.
  `model_responses` now persists `provider_request_id`, `price_source`, and
  `pricing_snapshot` for billing audit.

## Ports

| Port | Surface |
|---|---|
| `CreditLedger` | `grant` / `debit` / `getBalance` / `getRunDebitTotal` / `getAgentDebitTotals` / `getThreadDebitTotal` |

## Adapters

- **Drizzle** — production adapter using `credit_lots` and `credit_transactions`
  tables plus the `consume_credit_lots_fifo` PL/pgSQL function.
- **In-memory** — test/dev adapter.

## Schema adaptation (Upstream → Meridian Flow)

The copied upstream credit ledger domain port still carries `projectId` in its
input types (`CreditGrantInput`, `CreditDebitInput`, balance queries). The
Meridian Flow Drizzle adapter ignores `projectId` because:

- `credit_lots` and `credit_transactions` have no `projectId` column in the
  Meridian Flow schema.
- `consume_credit_lots_fifo(userId, amount, consumptionGroupId, usageEventId, metadata)`
  takes `userId` as the first parameter (no `projectId`).
- All balance/debit-total queries filter by `userId` only.

The port-level `projectId` fields remain in the contract types as passive
parity reference; they are not consumed by the Drizzle adapter.

## Invariants

- **Credit lots are canonical balance truth.** `getBalance()` sums
  `remaining_millicredits` from non-expired, non-debt lots (debt lots are
  always included regardless of expiry).
- **Usage-event idempotency.** `consume_credit_lots_fifo` is idempotent on
  `usage_event_id`: replayed model-response persistence does not double-charge.
- **FIFO consumption** with debt-lot overspend support.
- **`transactionId` for debits** is the `consumptionGroupId` (a
  `crypto.randomUUID()`), not a row ID from the DB.
- **Pricing source priority:** provider-reported cost (OpenRouter) → pinned
  rates (direct providers). The gateway-local `PinnedModelRate` type breaks the
  dependency cycle (gateway does not import billing types).

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — `turn-accounting.ts` and
  `ChildRunCoordinator` check/consume credits. `cancel-settlement.ts` handles
  soft-cancel/drain billing.
- **Depends on `@meridian/database/schema`** — `creditLots`, `creditTransactions`,
  `modelResponses` (for pricing audit columns).
- **Depends on `apps/server/server/shared/drizzle-transaction.ts`** — `currentDrizzleDb` / `runInDrizzleTransaction` ambient transaction context.
