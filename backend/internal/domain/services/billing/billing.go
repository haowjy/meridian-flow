package billing

import (
	"context"

	billingmodel "meridian/internal/domain/models/billing"
)

// CreditService defines user-facing billing operations.
type CreditService interface {
	GetBalance(ctx context.Context, userID string) (*billingmodel.CreditBalance, error)
	ListCreditPacks(ctx context.Context) ([]billingmodel.CreditPack, error)
	ListTransactions(ctx context.Context, userID string, req billingmodel.ListTransactionsRequest) (*billingmodel.CreditTransactionPage, error)
	CreateCheckoutSession(ctx context.Context, userID string, req CreateCheckoutSessionRequest) (*billingmodel.CheckoutSession, error)
	HandleStripeWebhook(ctx context.Context, req StripeWebhookRequest) error
}

// CreateCheckoutSessionRequest creates a Stripe checkout session for one credit pack.
type CreateCheckoutSessionRequest struct {
	PackID     string `json:"pack_id"`
	SuccessURL string `json:"success_url"`
	CancelURL  string `json:"cancel_url"`
}

// StripeWebhookRequest contains raw Stripe webhook payload and signature.
type StripeWebhookRequest struct {
	Payload   []byte
	Signature string
}
