# Phase 1: Schema Migration + Domain Types + Pure Functions

## Scope

Create the billing database schema, domain types, interfaces, pure cost calculation function, and noop implementations for dev/test. This is the foundation everything else builds on.

## Files to Create

### Migration

- `backend/migrations/00030_billing_credit_system.sql`
  - Copy the EXACT SQL from `billing-design.md` "Migration SQL" section (lines 1168-1459)
  - Includes: `credit_source_type` enum, `credit_transaction_type` enum, `credit_lots` table, `credit_transactions` table, `credit_balances` view, `consume_credit_lots_fifo()` function
  - Follow existing migration patterns — check `00001_initial_schema.sql` and `00029_folder_document_metadata.sql` for goose format
  - MUST include `-- +goose ENVSUB ON` in both Up and Down
  - MUST use `${TABLE_PREFIX}` for all tables, indexes, constraints, types, functions

### Domain Types

- `backend/internal/domain/models/billing/types.go`
  - `CreditBalance` struct (total, promotional, purchased, debt — all millicredits as int64)
  - `CreditPack` struct (PackID, Label, PriceCents, Credits, BonusCredits)
  - `CreditTransaction` struct (ID, UserID, TransactionType, AmountMillicredits, LotID, ConsumptionGroupID, UsageEventID, Metadata, CreatedAt)
  - `CreditLot` struct (ID, UserID, SourceType, OriginalAmountMillicredits, RemainingMillicredits, ExpiresAt, StripeSessionID, GrantReason, Metadata, CreatedAt)
  - `CheckoutSession` struct (SessionID, CheckoutURL, ExpiresAt)
  - `TokenUsage` struct (InputTokens, OutputTokens, ReasoningTokens, CachedTokens — all int64)
  - `ModelPricing` struct (InputMicrousdPer1K, OutputMicrousdPer1K, ReasoningMicrousdPer1K, CachedMicrousdPer1K, MarkupBasisPoints — all int64)
  - `CreditSettlementMode` type (string) with constants `CreditSettlementInlineAuthoritative` and `CreditSettlementDeferredToEnrichment`
  - `CreditTransactionPage` struct (Items, Limit, Offset, Total)

- `backend/internal/domain/models/billing/pricing.go`
  - `DefaultModelPricing` map from billing-design.md (5 models with all 5 fields each)
  - `CalculateCreditCost(pricing ModelPricing, usage TokenUsage) int64` pure function
  - `ceilDiv(numerator, denominator int64) int64` helper
  - Rules: integer math, every division rounds up, minimum 1 millicredit
  - `CreditPacks` slice with the 3 pack definitions (starter, writer, studio)
  - `SignupBonusMillicredits = 300_000` constant (300 credits)
  - `SignupBonusExpirationDays = 30` constant
  - `BillingNamespace` UUID constant for consumption_group_id derivation

### Domain Interfaces

- `backend/internal/domain/services/billing/billing.go`
  - `CreditService` interface (GetBalance, ListCreditPacks, ListTransactions, CreateCheckoutSession, HandleStripeWebhook)
  - Request/response types: `ListTransactionsRequest`, `CreateCheckoutSessionRequest`, `StripeWebhookRequest`

- `backend/internal/domain/services/billing/admission.go`
  - `CreditAdmissionChecker` interface with `CheckAdmission(ctx, userID) error`

- `backend/internal/domain/services/billing/settler.go`
  - `CreditSettler` interface with `SettleAuthoritativeRequest(ctx, SettleRequestInput) error` and `RetryPendingSettlement(ctx, RetryPendingSettlementInput) error`
  - `SettleRequestInput` struct
  - `RetryPendingSettlementInput` struct

- `backend/internal/domain/services/billing/granter.go`
  - `CreditGranter` interface with `InitializeSignupCredits(ctx, InitializeSignupCreditsRequest) (*InitializeSignupCreditsResult, error)`
  - Request/result types

- `backend/internal/domain/repositories/billing/credit_store.go`
  - `CreditStore` interface (GetBalance, ListTransactions, CreatePurchaseLot, CreateGrantLot, ConsumeFIFO, ExpireAvailableLots)
  - Request types: `CreatePurchaseLotRequest`, `CreateGrantLotRequest`, `ConsumeFIFORequest`, `ExpiredLot`

### Domain Error

- `backend/internal/domain/errors.go` (MODIFY — add to existing file)
  - Add `ErrInsufficientCredits` sentinel error
  - Add `InsufficientCreditsError` struct with BalanceMillicredits, RequiredMillicredits, ShortfallMillicredits fields
  - Follow the existing error pattern (Error(), Is() methods)
  - Add `NewInsufficientCreditsError` constructor

### Noop Implementations

- `backend/internal/service/billing/noop.go`
  - `NoopCreditAdmissionChecker` — always admits
  - `NoopCreditSettler` — always succeeds
  - Both must satisfy the domain interfaces
  - These are used for dev/test wiring

### Cost Calculation Tests

- `backend/internal/domain/models/billing/pricing_test.go`
  - Test `CalculateCreditCost` with known inputs/outputs
  - Test `ceilDiv` edge cases (exact division, remainder, zero input)
  - Test minimum 1 millicredit charge
  - Test all 5 models from the pricing table with sample token counts
  - Test zero tokens (should still return minimum 1)

## Patterns to Follow

- Domain models: `backend/internal/domain/models/docsystem/project.go`
- Domain interfaces: `backend/internal/domain/services/docsystem/project.go`
- Domain repositories: `backend/internal/domain/repositories/llm/turn.go`
- Domain errors: `backend/internal/domain/errors.go`
- Migration format: `backend/migrations/00029_folder_document_metadata.sql`

## Constraints

- Do NOT implement the service or repository layer — only types, interfaces, and pure functions
- Do NOT touch main.go wiring yet
- All millicredit values are int64, never float
- Use `uuid.UUID` for lot IDs, `string` for user IDs (matches existing pattern)

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./internal/domain/models/billing/...` passes
- [ ] Migration SQL is syntactically valid (goose format, proper ENVSUB)
- [ ] All interfaces compile and can be referenced from other packages
- [ ] NoopCreditAdmissionChecker and NoopCreditSettler satisfy their interfaces
