# features/billing

Presentation over server-owned USD strings and percentages. Stripe owns payment
truth and the server `CreditLedger` owns balances and transactions; the client
projects neither credits nor balance.

- One checkout attempt owns only the clicked control. Keep the catalog usable;
  show pending and failure with Retry on that control.
- Generation-fence attempts. Only the latest may redirect or write the handoff
  baseline.
- `?checkout=success` is a claim, not proof (the URL carries no session id and
  no status endpoint exists). Fresh ledger reads compared with
  the same-tab handoff baseline confirm a purchase; otherwise show reconciling
  and an honest terminal timeout. If either baseline read fails, fail closed.
- Capture the handoff baseline from fresh balance and transaction reads, never a
  stale cache that could fake a delta.
- Attribute by `(kind, createdAt, amountUsd)`, with the correct transaction kind:
  extra usage needs a new `purchase` of the requested amount, a plan a new
  `grant`. A pre-existing row or mode alone is never proof. Preserve whether handoff was
  checkout or portal: a portal return reuses the cancel URL and is neither a
  cancellation nor proof nothing was charged. Clear marker and baseline only at
  terminal status; a reload mid-poll resumes reconciliation.
- Keep one mounted `role="status"` region for return notices. Copy never promises
  a balance update.

Keep payment reconciliation honest even when the return URL looks successful.
