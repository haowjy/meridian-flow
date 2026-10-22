# domains/billing — Stripe gateway and FIFO credit ledger

Billing owns the payment/usage seam: Stripe supplies payment truth, while the
local ledger grants expiring lots and debits runtime usage. Runtime owns model
pricing and the fixed multiplier; billing receives metered millicredits.

## Boundary and ports

Millicredits are the internal unit for ledger rows, pricing output, thread
budgets, and runtime debits. `domain/money.ts` owns USD/Stripe-cent conversion;
routes translate millicredits to USD strings and usage percentages. Grant
dollar amounts and machine `reason` keys never cross the API/UI boundary;
`displayReason` is the user-facing activity label.

`CreditLedger` is user-scoped and exposes grant, debit, balance, breakdown,
transaction, thread-total, and unexpired-lot operations. It has no
`projectId`. Stripe gateway code is intentionally a concrete SDK seam: Stripe
is the subscription/payment authority, and webhook grant policy lives in
`domain/stripe-webhook-grants.ts`.

## Invariants

- Debits consume positive, unexpired lots in expiry/FIFO order and create or
  extend debt when usage goes negative.
- `consume_credit_lots_fifo` is the idempotency authority for `usageEventId`;
  adapters return its persisted consumption group, never a locally generated
  identifier.
- Free-tier keys are deterministic (`free_tier_{userId}_{periodStart}`) and
  the partial unique index fences concurrent grants.
- Extra-usage checkout grants require a paid Stripe session. Subscription
  grants come from `invoice.paid`, so expiry follows the invoice period.
- `ensureFreeTier()` grants one monthly `$0` lot only when the user has no
  unexpired subscription lot.
- Entitlement comes from unexpired lots: subscription first, otherwise free
  grant. `hasUnexpiredLot` checks expiry, not remaining balance.

The Drizzle adapter uses `credit_lots`, `credit_transactions`, and the FIFO
function; the in-memory adapter preserves the same port and identity rules.
Runtime calls the ledger through `turn-accounting.ts` and
`ChildRunCoordinator`. Both adapters share grant identity/display-label logic
from `domain/grant-identity.ts`.
