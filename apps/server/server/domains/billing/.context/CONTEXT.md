# domains/billing — Stripe gateway and FIFO credit ledger

Runtime owns model pricing and the fixed multiplier; billing receives metered
millicredits.

## Contracts

- `consume_credit_lots_fifo` is the idempotency authority for `usageEventId`;
  adapters return its persisted consumption group, never a locally generated
  identifier.
- The partial unique index on the deterministic free-tier key fences concurrent
  grants.
- Entitlement comes from unexpired lots: subscription first, otherwise free
  grant. `hasUnexpiredLot` checks expiry, not remaining balance, so a drained
  subscription lot still blocks the free grant.
