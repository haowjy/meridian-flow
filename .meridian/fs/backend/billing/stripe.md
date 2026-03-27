# Stripe Billing Flow

Stripe billing is processed through a signature-authenticated webhook endpoint that writes purchase/refund ledger changes idempotently.

## Webhook Entry

`POST /api/billing/webhooks/stripe` is intentionally excluded from JWT auth because Stripe signatures are verified inside the billing service.

## Supported Events

| Stripe event | Billing action |
| --- | --- |
| `checkout.session.completed` | Create purchase lot + purchase transaction |
| `charge.refunded` | Adjust lot balance and write refund transaction |
| `charge.dispute.created` | Reuse refund path |

## Checkout Completion Handling

1. The service constructs and verifies the webhook event from payload + signature.
2. It re-fetches the Checkout Session from Stripe API as source of truth.
3. It requires `payment_status=paid`, `mode=payment`, and required `user_id`/`pack_id` metadata.
4. It validates amount against backend `CreditPacks`.
5. It inserts the purchase lot and purchase transaction.

## Idempotency Layers

| Layer | Mechanism | Location |
| --- | --- | --- |
| Purchase lot write | `ON CONFLICT DO NOTHING` on unique `stripe_session_id` lot | `credit_store.CreatePurchaseLot` |
| Refund write | `refund` transaction existence check before insert | `credit_store.RefundLot` |
| FIFO consumption | advisory lock + prior `consumption_group_id` existence check | `consume_credit_lots_fifo` |
| Settlement grouping | deterministic `consumption_group_id = UUIDv5(BillingNamespace, usageEventID)` | `credit_settler` |

## File References

| Area | File references |
| --- | --- |
| Webhook route + handler | `backend/internal/app/domains/billing.go:84`, `backend/internal/handler/billing.go:119` |
| Auth bypass for webhook | `backend/internal/middleware/auth.go:25`, `backend/internal/middleware/auth.go:26` |
| Stripe event constants | `backend/internal/domain/billing/stripe.go:9` |
| Webhook dispatch | `backend/internal/service/billing/credit_service.go:136`, `backend/internal/service/billing/credit_service.go:149` |
| Authoritative session re-fetch + validation | `backend/internal/service/billing/credit_service.go:168`, `backend/internal/service/billing/credit_service.go:176`, `backend/internal/service/billing/credit_service.go:194` |
| Purchase lot write | `backend/internal/service/billing/credit_service.go:199`, `backend/internal/repository/postgres/billing/credit_store.go:152` |
| Refund/dispute path | `backend/internal/service/billing/credit_service.go:225`, `backend/internal/service/billing/credit_service.go:255` |
| Refund idempotency check | `backend/internal/repository/postgres/billing/credit_store.go:285`, `backend/internal/repository/postgres/billing/credit_store.go:299` |
| FIFO idempotency | `backend/migrations/00030_billing_credit_system.sql:129`, `backend/migrations/00030_billing_credit_system.sql:139` |
| Deterministic settlement group ID | `backend/internal/service/billing/credit_settler.go:62`, `backend/internal/service/billing/credit_settler.go:63` |
