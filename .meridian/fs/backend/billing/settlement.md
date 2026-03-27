# Generation Settlement

Settlement persists deterministic billing identifiers before credit consumption so retries can replay the same debit intent safely.

## Cost Computation

`CalculateCreditCost` uses integer-only ceiling math from token counts to microusd to millicredits and enforces a minimum bill of `1` millicredit.

Pricing resolution uses provider/model pricing when available and falls back to conservative `FallbackModelPricing` when resolution fails.

## Deterministic IDs

`usageEventID` is `<turnID>:<requestIndex>` and `consumptionGroupID` is `UUIDv5(BillingNamespace, usageEventID)`.

`BillingNamespace` is fixed and changing it breaks idempotent retries for pending settlements.

## Write-Ahead Settlement Path

1. Compute pricing and deterministic billing fields.
2. Persist billing fields to generation metadata (`write-ahead`).
3. Run FIFO consumption with deterministic IDs.
4. Mark status `settled` on success or `pending` on failure.

## Settlement Modes

| Mode | When used | Runtime path |
| --- | --- | --- |
| `inline_authoritative` | Provider has authoritative token counts at stream completion (Anthropic default) | Stream executor settles immediately |
| `deferred_to_enrichment` | Token counts finalized after stream completion (OpenRouter default) | Stream marks pending, then enrichment job settles |

## Retry and Reconciliation

`RetryPendingSettlement` reloads persisted write-ahead fields, retries FIFO consume, increments retry count, and marks `failed` once retries reach `5`.

Pending-settlement listing skips placeholder rows that lack complete write-ahead fields so reconciliation only retries valid debit intents.

## File References

| Area | File references |
| --- | --- |
| Integer-only cost computation | `backend/internal/domain/billing/pricing.go:113`, `backend/internal/domain/billing/pricing.go:121`, `backend/internal/domain/billing/pricing.go:133` |
| Fallback pricing | `backend/internal/domain/billing/pricing.go:51`, `backend/internal/service/billing/credit_settler.go:201`, `backend/internal/service/billing/credit_settler.go:214` |
| Deterministic IDs + stable namespace | `backend/internal/domain/billing/pricing.go:22`, `backend/internal/domain/billing/pricing.go:24`, `backend/internal/service/billing/credit_settler.go:62` |
| Write-ahead then consume then status | `backend/internal/service/billing/credit_settler.go:71`, `backend/internal/service/billing/credit_settler.go:78`, `backend/internal/service/billing/credit_settler.go:94`, `backend/internal/service/billing/credit_settler.go:108` |
| Settlement mode constants | `backend/internal/domain/billing/types.go:32` |
| Provider-to-mode wiring | `backend/internal/app/domains/billing.go:38`, `backend/internal/app/domains/billing.go:41`, `backend/internal/service/llm/streaming/turn_creation.go:145` |
| Deferred pending marker + enrichment enqueue | `backend/internal/service/llm/streaming/billing_handler.go:108`, `backend/internal/service/llm/streaming/billing_handler.go:116`, `backend/internal/service/llm/streaming/billing_handler.go:159` |
| Deferred settlement execution in enrichment | `backend/internal/jobs/enrich_generation.go:399`, `backend/internal/jobs/enrich_generation.go:435` |
| Retry/failed threshold | `backend/internal/service/billing/credit_settler.go:19`, `backend/internal/service/billing/credit_settler.go:142`, `backend/internal/service/billing/credit_settler.go:175` |
| Reconciliation safety filter | `backend/internal/repository/postgres/billing/generation_billing_store.go:259`, `backend/internal/repository/postgres/billing/generation_billing_store.go:261` |
