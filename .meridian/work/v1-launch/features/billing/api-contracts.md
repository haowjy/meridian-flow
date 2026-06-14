---
detail: standard
audience: developer
---

# Billing API Contracts

All responses use JSON. Errors use RFC 7807 problem details.

## Endpoints

### `GET /api/billing/packs`

Authenticated. Returns the server-authoritative pack catalog.

Response `200`:
```json
{
  "packs": [
    {
      "pack_id": "starter",
      "label": "Starter",
      "price_cents": 500,
      "credits": 500,
      "bonus_credits": 0
    }
  ]
}
```

Errors: `401`

---

### `GET /api/billing/balance`

Authenticated.

Response `200`:
```json
{
  "total_balance_millicredits": 845000,
  "promotional_balance_millicredits": 120000,
  "purchased_balance_millicredits": 725000,
  "debt_balance_millicredits": 0,
  "display_total_credits": "845.0"
}
```

Errors: `401`

---

### `GET /api/billing/transactions?limit=50&offset=0`

Authenticated. Returns usage and purchase history.

Response `200`:
```json
{
  "items": [
    {
      "id": "tx_123",
      "transaction_type": "consumption",
      "amount_millicredits": -2875,
      "created_at": "2026-03-20T12:00:00Z",
      "metadata": {
        "assistant_turn_id": "turn_1",
        "request_index": 0,
        "model": "claude-sonnet-4-6"
      }
    }
  ],
  "limit": 50,
  "offset": 0,
  "total": 137
}
```

Errors: `401`

---

### `POST /api/billing/checkout-sessions`

Authenticated. Starts a Stripe Checkout flow.

Request:
```json
{
  "pack_id": "writer",
  "success_url": "http://localhost:3000/settings/billing?checkout=success",
  "cancel_url": "http://localhost:3000/settings/billing?checkout=cancel"
}
```

Response `201`:
```json
{
  "session_id": "cs_test_123",
  "checkout_url": "https://checkout.stripe.com/...",
  "expires_at": "2026-03-20T12:30:00Z"
}
```

Errors: `400` invalid `pack_id`, `401`, `502` Stripe session creation failed

---

### `POST /api/billing/webhooks/stripe`

Unauthenticated Stripe callback. JWT bypassed intentionally (see [stripe-integration.md](./stripe-integration.md)).

Response `200`:
```json
{ "received": true }
```

Errors: `400` invalid signature / malformed event / invalid pack metadata, `500` internal persistence failure

---

### `POST /api/auth/initialize`

See `auth.md` for the full endpoint specification. Called by frontend after login and after email verification to trigger signup credit grant.

---

## Error Shapes

### `402` Insufficient Credits (HTTP)

Returned only when the initial request cannot start. Never returned after SSE stream begins.

```json
{
  "type": "about:blank",
  "title": "Payment Required",
  "status": 402,
  "detail": "insufficient credits",
  "balance_millicredits": 0,
  "required_millicredits": 1,
  "shortfall_millicredits": 1
}
```

### `CREDITS_EXHAUSTED` SSE Event

Emitted when credits are exhausted mid-stream (after `201` has been sent).

```json
{
  "type": "CREDITS_EXHAUSTED",
  "turnId": "turn_123",
  "threadId": "thread_456",
  "requestIndex": 3,
  "phase": "tool_continue",
  "balanceMillicredits": -2500,
  "requiredMillicredits": 1,
  "shortfallMillicredits": 2501,
  "message": "Credits exhausted. Buy more credits to continue this thread.",
  "billingUrl": "/settings/billing"
}
```

```go
const MeridianEventTypeCreditsExhausted = "CREDITS_EXHAUSTED"

type MeridianCreditsExhaustedEvent struct {
    Type                  string `json:"type"`
    TurnID                string `json:"turnId"`
    ThreadID              string `json:"threadId"`
    RequestIndex          int    `json:"requestIndex"`
    Phase                 string `json:"phase"`
    BalanceMillicredits   int64  `json:"balanceMillicredits"`
    RequiredMillicredits  int64  `json:"requiredMillicredits"`
    ShortfallMillicredits int64  `json:"shortfallMillicredits"`
    Message               string `json:"message"`
    BillingURL            string `json:"billingUrl"`
}
```

## Domain Error and Handler Mapping

```go
package domain

var ErrInsufficientCredits = errors.New("insufficient credits")

type InsufficientCreditsError struct {
    BalanceMillicredits   int64
    RequiredMillicredits  int64
    ShortfallMillicredits int64
}

func (e *InsufficientCreditsError) Error() string { return "insufficient credits" }
func (e *InsufficientCreditsError) Is(target error) bool {
    return target == ErrInsufficientCredits
}
```

Handler mapping in `backend/internal/handler/helpers.go`:

```go
func handleError(w http.ResponseWriter, err error, cfg *config.Config) {
    var insufficientErr *domain.InsufficientCreditsError
    if errors.As(err, &insufficientErr) {
        httputil.RespondErrorWithExtras(w, http.StatusPaymentRequired, err.Error(), map[string]interface{}{
            "balance_millicredits":   insufficientErr.BalanceMillicredits,
            "required_millicredits":  insufficientErr.RequiredMillicredits,
            "shortfall_millicredits": insufficientErr.ShortfallMillicredits,
        })
        return
    }
    // existing mappings...
}
```

Also map `402` in `backend/internal/httputil/response.go`'s `errorTypeFromStatus(...)` so the RFC 7807 body has a stable type URI.
