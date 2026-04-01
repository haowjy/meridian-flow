# Phase 4: HTTP Handlers + CreditGate Middleware + Wiring

## Scope

Create billing HTTP handlers, the CreditGate middleware, Stripe webhook endpoint, 402 error mapping, auth bypass for webhooks, route registration, and full DI wiring in main.go.

## Dependencies

- Phase 1: domain types, error types
- Phase 2: repository
- Phase 3: service layer

## Files to Create/Modify

### Billing Handler

- `backend/internal/handler/billing.go` (NEW)
  - `BillingHandler` struct with `creditService`, `logger`, `cfg` fields
  - Constructor: `NewBillingHandler(creditService billing.CreditService, logger *slog.Logger, cfg *config.Config) *BillingHandler`

  Endpoints:

  - `GetPacks(w, r)` → `GET /api/billing/packs`
    - Call `creditService.ListCreditPacks(ctx)`
    - Return 200 with pack catalog

  - `GetBalance(w, r)` → `GET /api/billing/balance`
    - Extract userID from context via `httputil.GetUserID(r)`
    - Call `creditService.GetBalance(ctx, userID)`
    - Return 200 with balance + display_total_credits (formatted)

  - `ListTransactions(w, r)` → `GET /api/billing/transactions`
    - Extract userID, parse `limit` and `offset` query params using `QueryInt` helper
    - Call `creditService.ListTransactions(ctx, userID, req)`
    - Return 200 with paginated response

  - `CreateCheckoutSession(w, r)` → `POST /api/billing/checkout-sessions`
    - Parse JSON body: `pack_id`, `success_url`, `cancel_url`
    - Extract userID
    - Call `creditService.CreateCheckoutSession(ctx, userID, req)`
    - Return 201 with session_id, checkout_url, expires_at

  - `HandleStripeWebhook(w, r)` → `POST /api/billing/webhooks/stripe`
    - Read raw body (before JSON parsing — needed for signature verification)
    - Extract `Stripe-Signature` header
    - Call `creditService.HandleStripeWebhook(ctx, req)`
    - Return 200 `{"received": true}`
    - No JWT required (Stripe auth via signature)

### CreditGate Middleware

- `backend/internal/middleware/credit_gate.go` (NEW)
  - `CreditGate(checker billing.CreditAdmissionChecker) func(http.Handler) http.Handler`
  - Extract userID from request context
  - Call `checker.CheckAdmission(ctx, userID)`
  - On `InsufficientCreditsError` → return 402 with RFC 7807 body including balance/required/shortfall fields
  - On other error → return 500
  - On success → call `next.ServeHTTP(w, r)`

### Error Mapping

- `backend/internal/handler/helpers.go` (MODIFY)
  - Add `InsufficientCreditsError` case to `domainErrorStatusCode` → return `http.StatusPaymentRequired`
  - Add `InsufficientCreditsError` case to `handleError` → use `RespondErrorWithExtras` with balance/required/shortfall fields

### Auth Middleware Bypass

- `backend/internal/middleware/auth.go` (MODIFY)
  - Add `POST /api/billing/webhooks/stripe` to the JWT bypass list (alongside existing `/health` and `/ws/*` bypasses)

### Route Registration

- `backend/cmd/server/main.go` (MODIFY)

  Add to route registration:
  ```go
  // Billing routes (all authenticated except webhook)
  mux.HandleFunc("GET /api/billing/packs", billingHandler.GetPacks)
  mux.HandleFunc("GET /api/billing/balance", billingHandler.GetBalance)
  mux.HandleFunc("GET /api/billing/transactions", billingHandler.ListTransactions)
  mux.HandleFunc("POST /api/billing/checkout-sessions", billingHandler.CreateCheckoutSession)
  mux.HandleFunc("POST /api/billing/webhooks/stripe", billingHandler.HandleStripeWebhook)
  ```

  Add CreditGate middleware wrapping for `POST /api/turns` route (or apply to the specific handler).

  Add DI wiring:
  ```go
  // Billing
  creditStore := postgresBilling.NewCreditStore(pool, cfg.TablePrefix)
  admissionChecker := serviceBilling.NewCreditAdmissionChecker(creditStore, logger)
  creditSettler := serviceBilling.NewCreditSettler(creditStore, generationBillingStore, logger)
  creditGranter := serviceBilling.NewCreditGranter(creditStore, logger)
  stripeClient := serviceBilling.NewStripeClient(cfg.StripeSecretKey, cfg.StripeWebhookSecret)
  creditService := serviceBilling.NewCreditService(creditStore, stripeClient, logger)
  billingHandler := handler.NewBillingHandler(creditService, logger, cfg)
  ```

### Config

- `backend/internal/config/config.go` (MODIFY)
  - Add `StripeSecretKey`, `StripeWebhookSecret`, `StripePriceIDMap` fields
  - Load from env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - These are optional in dev (billing gracefully degrades)

### GenerationBillingStore Implementation

- `backend/internal/repository/postgres/billing/generation_billing_store.go` (NEW)
  - Implements `GenerationBillingStore` interface from Phase 3
  - Reads/writes billing fields as JSON keys inside `turns.response_metadata`
  - Uses JSONB operators to update nested fields without overwriting unrelated metadata
  - `ListPendingSettlements` scans for generation records with `billing_status = pending` older than threshold

## Patterns to Follow

- Handler pattern: `backend/internal/handler/project.go`
- Middleware pattern: `backend/internal/middleware/auth.go`
- Route registration: `backend/cmd/server/main.go` (lines 360-453)
- Config loading: `backend/internal/config/config.go`

## Constraints

- CreditGate middleware wraps only billable AI endpoints (`POST /api/turns`), NOT billing API routes and NOT webhook routes
- Webhook handler reads raw body for signature verification — do not pre-parse JSON
- Auth bypass is exact path match, not prefix
- Stripe env vars are optional in dev — if missing, Stripe operations return a clear error

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./internal/handler/...` passes
- [ ] Server starts without Stripe keys (graceful degradation)
- [ ] `GET /api/billing/packs` returns pack catalog (no auth needed beyond JWT)
- [ ] `GET /api/billing/balance` returns zero balance for new users
- [ ] `POST /api/billing/webhooks/stripe` is accessible without JWT
- [ ] `POST /api/turns` is gated by CreditGate middleware
