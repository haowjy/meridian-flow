# features/billing

The client projects neither credits nor balance. Stripe owns payment truth and
the server `CreditLedger` owns balances and transactions.

- One checkout attempt owns only the clicked control: the catalog stays usable,
  and pending, failure and Retry show on that control. Attempts are
  generation-fenced; only the latest may redirect or write the handoff baseline.
- `?checkout=success` is a claim, not proof: the URL carries no session id and no
  status endpoint exists. Only fresh ledger reads compared with the same-tab
  handoff baseline confirm a purchase; otherwise show reconciling, then an honest
  timeout. If either baseline read fails, fail closed. A baseline from a stale
  cache could fake a delta.
- Attribute by `(kind, createdAt, amountUsd)`: extra usage needs a new `purchase`
  of the requested amount, a plan a new `grant`. A pre-existing row or mode alone
  proves nothing.
- A portal return reuses the cancel URL and is neither a cancellation nor proof
  nothing was charged, so the handoff records whether it was checkout or portal.
- Clear marker and baseline only at terminal status, so a reload mid-poll resumes
  reconciliation.
- Return-notice copy never promises a balance update.
