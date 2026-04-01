# Phase 3: Service Layer

## Scope

Implement the billing service layer: CreditService (user-facing operations), CreditAdmissionChecker, CreditSettler, and CreditGranter. These orchestrate business logic on top of the CreditStore repository.

## Dependencies

- Phase 1: domain types, interfaces, pure functions
- Phase 2: CreditStore repository

## Files to Create

### CreditService

- `backend/internal/service/billing/credit_service.go`
  - Implements `billing.CreditService`
  - Constructor: `NewCreditService(store CreditStore, stripeClient StripeClient, logger *slog.Logger) *creditService`

  Methods:

  - `GetBalance(ctx, userID)` — delegates to store
  - `ListCreditPacks(ctx)` — returns the hardcoded pack catalog from `billing.CreditPacks`
  - `ListTransactions(ctx, userID, req)` — delegates to store with validation
  - `CreateCheckoutSession(ctx, userID, req)` — validates pack_id against catalog, calls Stripe to create checkout session, returns session URL
  - `HandleStripeWebhook(ctx, req)` — verifies signature, fetches session from Stripe, validates amount matches pack, calls `store.CreatePurchaseLot`

### CreditAdmissionChecker

- `backend/internal/service/billing/admission_checker.go`
  - Implements `billing.CreditAdmissionChecker`
  - Constructor: `NewCreditAdmissionChecker(store CreditStore, logger *slog.Logger) *creditAdmissionChecker`
  - `CheckAdmission(ctx, userID)` — gets balance, returns `InsufficientCreditsError` if `total_balance_millicredits <= 0`
  - Fail-closed: if balance lookup fails, return the error (blocks the request)

### CreditSettler

- `backend/internal/service/billing/credit_settler.go`
  - Implements `billing.CreditSettler`
  - Constructor: `NewCreditSettler(store CreditStore, generationStore GenerationBillingStore, logger *slog.Logger) *creditSettler`

  `SettleAuthoritativeRequest(ctx, SettleRequestInput)`:
  1. Derive `usageEventID = fmt.Sprintf("%s:%d", req.TurnID, req.RequestIndex)`
  2. Derive `consumptionGroupID = uuid.NewSHA1(billing.BillingNamespace, []byte(usageEventID))`
  3. Compute `amountMillicredits = CalculateCreditCost(lookupPricing(req.Model), tokenUsage)`
  4. Persist billing fields on generation record (usage_event_id, consumption_group_id, amount_millicredits) via GenerationBillingStore
  5. Call `store.ConsumeFIFO(...)` with stored amount
  6. On success: mark generation `billing_status = settled`
  7. On failure: mark generation `billing_status = pending` with error, log warning

  `RetryPendingSettlement(ctx, RetryPendingSettlementInput)`:
  1. Load stored billing fields from generation record
  2. Call `store.ConsumeFIFO(...)` with stored amount (idempotent)
  3. On success: mark `billing_status = settled`
  4. On failure: increment retry count, mark `billing_status = pending` or `failed` if max retries exceeded

### CreditGranter

- `backend/internal/service/billing/credit_granter.go`
  - Implements `billing.CreditGranter`
  - `InitializeSignupCredits(ctx, req)`:
    - Check `req.EmailVerified` — return early if not verified
    - Call `store.CreateGrantLot(...)` with `grant_reason = "signup_bonus_v1"`, `expires_at = now + 30 days`
    - Handle unique constraint violation as "already initialized" (not error)
    - Return result with balances

### GenerationBillingStore Interface

- `backend/internal/domain/repositories/billing/generation_billing_store.go`
  - Interface for reading/writing billing fields on generation records
  - `SetBillingFields(ctx, turnID string, requestIndex int, fields BillingFields) error`
  - `GetBillingFields(ctx, turnID string, requestIndex int) (*BillingFields, error)`
  - `MarkBillingStatus(ctx, turnID string, requestIndex int, status string, lastError string) error`
  - `ListPendingSettlements(ctx, olderThan time.Time, limit int) ([]PendingSettlement, error)`
  - `BillingFields` struct: UsageEventID, ConsumptionGroupID, AmountMillicredits, Status, LastError, RetryCount

### StripeClient Interface

- `backend/internal/domain/services/billing/stripe.go`
  - `StripeClient` interface for Stripe API calls (enables test mocking)
  - `CreateCheckoutSession(ctx, CreateStripeSessionRequest) (*StripeSession, error)`
  - `ConstructWebhookEvent(payload []byte, signature string) (*StripeEvent, error)`
  - `RetrieveSession(ctx, sessionID string) (*StripeSession, error)`

### Stripe Client Implementation

- `backend/internal/service/billing/stripe_client.go`
  - Wraps `github.com/stripe/stripe-go/v82` SDK
  - Constructor takes API key and webhook secret
  - Implements the StripeClient interface

### Tests

- `backend/internal/service/billing/credit_settler_test.go`
  - Unit test SettleAuthoritativeRequest with mocked store
  - Test idempotent settlement (ConsumeFIFO no-ops on retry)
  - Test failure path (DB error → pending status)
  - Test RetryPendingSettlement happy path and max retry exceeded

- `backend/internal/service/billing/admission_checker_test.go`
  - Test positive balance → admit
  - Test zero balance → deny with InsufficientCreditsError
  - Test negative balance → deny
  - Test store error → deny (fail closed)

- `backend/internal/service/billing/credit_granter_test.go`
  - Test first-time signup → credits granted
  - Test duplicate signup → no-op, already initialized
  - Test unverified email → no credits

## Patterns to Follow

- Service pattern: `backend/internal/service/docsystem/project.go`
- Validation: `github.com/go-ozzo/ozzo-validation/v4`
- Logging: `log/slog`

## Constraints

- CreditSettler MUST persist billing fields on the generation record BEFORE calling ConsumeFIFO (write-ahead pattern)
- AdmissionChecker MUST fail closed — any error blocks the request
- CalculateCreditCost is called from the domain models package, not reimplemented
- Stripe SDK dependency: `github.com/stripe/stripe-go/v82`

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./internal/service/billing/...` passes
- [ ] Settler write-ahead pattern: billing fields persisted before FIFO call (verifiable in test mock call order)
- [ ] AdmissionChecker fail-closed: store error returns error (not nil)
