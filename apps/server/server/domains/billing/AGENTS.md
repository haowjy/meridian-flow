# domains/billing

Billing is two things: a thin Stripe SDK gateway for collecting payment, and a
FIFO `CreditLedger` for real-time usage lots. Stripe owns checkout, customer
portal, subscriptions, and webhook payment truth; Meridian owns only the ledger
behavior Stripe cannot provide during model calls.

Internal amounts stay in **millicredits** (`$1 = 100,000 millicredits`) across
ledger rows, pricing output, and runtime debits. API routes convert those values
to USD strings and usage percentages at the boundary; clients never see
"credits" or grant dollar amounts.

Do not rebuild a payment-provider abstraction, subscription store, fake Stripe
provider, or app-owned subscription state machine here. If code needs
subscription status, ask Stripe or infer entitlement from unexpired ledger lots.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for ports, adapters, and
invariants.
