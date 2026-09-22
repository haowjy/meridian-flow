# features/billing

Presentation over the server's USD strings and percentages. Stripe owns
checkout/payment truth; the server `CreditLedger` owns balance and transactions.
The client projects no credits and no balance.

Checkout is P0 server-confirmed:

- One `useCreateCheckoutSession` attempt owns the live control. Only the clicked
  plan/extra-usage control is pending (`aria-busy`, "Opening checkout…"), and
  only that control shows the failure `InlineErrorRow` + Retry. Do not disable
  the whole catalog on `checkout.isPending`.
- A returned `?checkout=success` is a claim, not proof: the success URL carries
  no session id and there is no session-status endpoint. `useCheckoutReturn`
  confirms only after the ledger shows a delta attributable to this checkout,
  measured against the same-tab baseline captured at session creation; otherwise
  it shows reconciling → timeout. Never fabricate a confirmation or project
  credits.
- The baseline is captured in `useCreateCheckoutSession` from the cached
  balance/transactions. A missing baseline leaves the return unconfirmed by
  design. Do not "fix" that by trusting Stripe's redirect.
