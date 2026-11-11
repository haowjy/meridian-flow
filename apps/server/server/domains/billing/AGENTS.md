# domains/billing

Stripe owns subscriptions and payment truth. Don't add a subscription store or
payment-provider abstraction: for subscription status, ask Stripe or infer
entitlement from unexpired ledger lots. Ledger contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
