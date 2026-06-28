# domains/billing — Stripe gateway + FIFO credit ledger

Billing owns the payment/usage seam for model calls. Stripe collects money and
emits payment events; the local ledger turns approved grants into expiring FIFO
lots and consumes those lots during runtime turns.

## What it owns

- **Stripe gateway** — a thin SDK wrapper for customer creation, checkout,
  customer portal sessions, live-subscription lookup, webhook construction, and
  webhook-to-grant resolution.
- **Credit ledger port** — the user-scoped FIFO balance contract used by billing
  routes, webhooks, free-tier provisioning, runtime turn gating, and runtime
  debits.
- **Billing catalog** — server-owned plan and extra-usage definitions, including
  Stripe price env names and internal grant amounts. Public catalog responses
  omit grant amounts.
- **Free tier provisioning** — `ensureFreeTier()` grants a monthly $0 lot only
  when the user has no unexpired subscription lot.

Model token pricing does **not** live here. Runtime owns pricing and the fixed
1.15 multiplier in [`../../runtime/costing/`](../../runtime/costing/); billing receives
metered millicredits from runtime.

## Unit boundary

Millicredits are the internal accounting unit for ledger storage, pricing output,
thread budget math, and transaction rows. The domain `money.ts` module owns
USD/Stripe-cent conversion; routes are the boundary that translate millicredits
into USD display strings and included-usage percentages. Grant dollar
amounts are a server-side tuning lever and must not cross the API/UI boundary.

## Ports

| Port | Surface | Contract |
|---|---|---|
| `CreditLedger` | `grant`, `debit`, `getBalance`, `getBalanceBreakdown`, `listTransactions`, `getThreadDebitTotal`, `hasUnexpiredLot` | User-scoped ledger. No `projectId`; name stays `CreditLedger` because the internal unit deliberately stays millicredits. |

`CreditLedger` exposes internal rows and lot views; HTTP contracts map those to
USD/percentage shapes before returning them to the client.

## Adapters

- **Drizzle credit ledger** — production adapter over `credit_lots`,
  `credit_transactions`, and `consume_credit_lots_fifo`.
- **In-memory credit ledger** — test/runtime adapter with the same port shape.
- **Stripe billing gateway** — Stripe SDK wrapper. It is intentionally not hidden
  behind a generic payment-provider port because Stripe is the subscription and
  payment state authority.

## Invariants

- **FIFO lot consumption.** Debits consume unexpired positive lots in expiry/FIFO
  order and create/extend debt when usage goes negative.
- **Usage-event idempotency.** Replaying the same `usageEventId` must not
  double-charge a model response. The SQL function `consume_credit_lots_fifo` is
  the idempotency authority and returns the persisted `consumption_group_id`; the
  Drizzle adapter returns that, never a locally-generated id, so a concurrent
  replay can't surface a transaction id that was never written.
- **Machine identity vs display reason.** A grant's `reason` is a machine
  idempotency/grouping key only (`free_tier_*`, `signup`, `monthly_*`, Stripe
  ids) and must never reach users; the human activity-feed label travels in the
  separate `displayReason` field. `domain/grant-identity.ts` owns lot-source,
  idempotency identity, free-tier detection, and display-label resolution, and is
  shared by both ledger adapters so in-memory and Postgres agree on dedup.
- **Free-tier idempotency.** Free lots use deterministic keys
  `free_tier_{userId}_{periodStart}` and the DB partial unique index
  `credit_lots_free_tier_grant` fences concurrent grants.
- **Payment-status gating.** Extra-usage checkout grants only resolve when Stripe
  says the payment session is paid.
- **Subscription grants come from `invoice.paid`.** Subscription checkout only
  creates the subscription; the grant is based on the paid invoice line period so
  expiry follows Stripe's immutable billing period.
- **Entitlement comes from lots.** Subscription mode is an unexpired
  `subscription` lot; free mode is an unexpired `grant` lot when no subscription
  lot exists. `hasUnexpiredLot()` checks expiry, not remaining balance.
- **USD conversion is centralized.** Ledger and runtime code keep millicredits;
  `domain/money.ts` owns USD and Stripe-cent conversion; billing routes compute
  the boundary contract: purchased USD balance, transaction USD, and the
  discriminated `includedUsage` (`{none}` | `{subscription|free, remainingPercent,
  overBudget}`) plus `canStartTurn`. The server emits "remaining" (not consumed)
  so the client renders directly without re-deriving.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — `turn-accounting.ts` and
  `ChildRunCoordinator` check/debit usage through `CreditLedger`.
- **Depends on `@meridian/database/schema`** — `users.stripe_customer_id`,
  `credit_lots`, `credit_transactions`, and the FIFO debit function.
- **Depends on `apps/server/server/shared/drizzle-transaction.ts`** —
  `currentDrizzleDb` / `runInDrizzleTransaction` ambient transaction context.
