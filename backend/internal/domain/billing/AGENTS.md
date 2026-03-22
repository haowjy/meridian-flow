# Billing Domain

Types and interfaces for the prepaid credit wallet. Import: `meridian/internal/domain/billing`.

## Key Concepts

- 1 credit = $0.01 = 1,000 millicredits. All amounts are `int64` millicredits -- never float.
- Credits come in lots (purchase or grant). FIFO multi-lot deduction with `pg_advisory_xact_lock`.
- Monthly free-tier refresh: 100 credits (100,000 millicredits), 60-day expiration.
- Purchased credit packs: 365-day expiration. Catalog in `pricing.go`.
- Two settlement modes (`CreditSettlementMode`):
  - `inline_authoritative` -- Anthropic: settle immediately from provider response metadata
  - `deferred_to_enrichment` -- OpenRouter: mark pending, reconcile via background job with generation stats API
- `FallbackModelPricing` used when model not found in capability YAML. Default markup: 1500 basis points.

## Interfaces

| Interface | Purpose | Key consumers |
|-----------|---------|---------------|
| `CreditService` | User-facing CRUD, checkout, webhooks | `handler/billing.go` |
| `CreditAdmissionChecker` | Balance gate before streaming | middleware, streaming service |
| `CreditSettler` | Post-response settlement | streaming cleanup, enrichment job |
| `CreditGranter` | Signup/monthly credit refresh | auth handler |
| `CreditStore` | Lot/transaction persistence (FIFO) | `repository/postgres/billing/` |
| `GenerationBillingStore` | Generation billing records | `repository/postgres/billing/` |
| `ModelPricingResolver` | Model cost lookup | settler impl |
| `StripeClient` | Stripe checkout/webhook | billing service impl |

## Conventions

- Settlement uses write-ahead pattern: persist billing fields -> `ConsumeFIFO` -> mark settled.
- `TurnStatus = "credit_limited"` when admission check fails mid-stream.
- Compile-time assertions: `var _ billing.CreditSettler = (*creditSettler)(nil)` in every implementation.

## Files

| File | Contents |
|------|----------|
| `types.go` | CreditBalance, CreditPack, CreditLot, TokenUsage, settlement/source/transaction enums |
| `pricing.go` | ModelPricing, CalculateCreditCost, pack catalog, constants |
| `service.go` | CreditService interface |
| `admission.go` | CreditAdmissionChecker interface |
| `settler.go` | CreditSettler, ModelPricingResolver, SettleRequestInput |
| `granter.go` | CreditGranter interface |
| `stripe.go` | StripeClient interface |
| `credit_store.go` | CreditStore interface (FIFO, lots, transactions) |
| `billing_store.go` | GenerationBillingStore interface |
