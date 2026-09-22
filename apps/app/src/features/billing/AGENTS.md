# features/billing

Presentation over the server's USD strings and percentages. Stripe owns
checkout/payment truth; the server `CreditLedger` owns balance and transactions.
The client projects no credits and no balance.

Checkout is P0 server-confirmed:

- One `useCreateCheckoutSession` attempt owns the live control. Only the clicked
  plan/extra-usage control is pending (`aria-busy`, "Opening checkout…"), and
  only that control shows the failure `InlineErrorRow` + Retry. Do not disable
  the whole catalog on `checkout.isPending`.
- Only the latest attempt may redirect or write a baseline. `onMutate` bumps a
  generation; a superseded `onSuccess` returns without calling `onHandoff` or
  `location.assign`.
- A returned `?checkout=success` is a claim, not proof: the success URL carries
  no session id and there is no session-status endpoint. `useCheckoutReturn`
  confirms only when a fresh ledger read shows a row attributable to this
  checkout, measured against the same-tab baseline captured at handoff;
  otherwise it shows reconciling, then an honest timeout.
- The baseline is captured in `BillingPage`'s `onHandoff` from **fresh** balance
  and transactions reads before the redirect. A stale cache read could miss a
  purchase already on the server and fake a delta. If either read fails, write
  no baseline: the return fails closed to `unverified` and never confirms.
- Attribution is a transaction fingerprint `(kind, createdAt, amountUsd)`.
  Extra usage needs a new `purchase` with the requested amount; a plan needs a
  new `grant` while included usage is a subscription. A row present at handoff
  is never a delta, and mode alone is never proof.
- The handoff kind (`checkout` vs `portal`) is stored with the baseline. A
  portal return reuses the cancel URL, so it must not be read as a cancellation
  or as "nothing was charged."
- The `?checkout=` marker and baseline clear together, through the router, only
  at a terminal status (`confirmed`, `timeout`, `unverified`, `cancelled`,
  `portal`). A reload mid-poll resumes reconciliation.
- `CheckoutReturnNotice` keeps one `role="status"` region mounted and changes
  its text so the status is announced. Copy never promises a balance update.
