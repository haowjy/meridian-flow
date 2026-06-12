# domains/billing — credit ledger & pricing

Owns the credit lot model (canonical balance truth), the `CreditLedger` port,
and model-call pricing conversions. The runtime cost gate and spawn rollups
consume this domain.

## What it owns

- **Credit ledger port** — `grant`, `debit` (FIFO lot consumption with
  usage-event idempotency), `getBalance`, and per-run/per-agent/per-thread
  debit total queries.
- **Pricing** — `ModelTokenRate` lookup and `computeModelCost` for converting
  token usage to USD and millicredits.
- **Domain types** — `CreditGrantInput`, `CreditDebitInput`, `CreditLedger`
  interface.

## Ports

| Port | Surface |
|---|---|
| `CreditLedger` | `grant` / `debit` / `getBalance` / `getRunDebitTotal` / `getAgentDebitTotals` / `getThreadDebitTotal` |

## Adapters

- **Drizzle** — production adapter using `credit_lots` and `credit_transactions`
  tables plus the `consume_credit_lots_fifo` PL/pgSQL function.
- **In-memory** — test/dev adapter.

## Schema adaptation (Voluma → Meridian Flow)

The copied Voluma credit ledger domain port still carries `workbenchId` in its
input types (`CreditGrantInput`, `CreditDebitInput`, balance queries). The
Meridian Flow Drizzle adapter ignores `workbenchId` because:

- `credit_lots` and `credit_transactions` have no `workbenchId` column in the
  Meridian Flow schema.
- `consume_credit_lots_fifo(userId, amount, consumptionGroupId, usageEventId, metadata)`
  takes `userId` as the first parameter (no `workbenchId`).
- All balance/debit-total queries filter by `userId` only.

The port-level `workbenchId` fields remain in the contract types as passive
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

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — `turn-accounting.ts` and
  `ChildRunCoordinator` check/consume credits.
- **Depends on `@meridian/database/schema`** — `creditLots`, `creditTransactions`.
- **Depends on `lib/` shared** — `currentDrizzleDb` transaction context.
