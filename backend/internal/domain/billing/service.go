package billing

import (
	"context"

)

// CreditService defines user-facing billing operations.
type CreditService interface {
	GetBalance(ctx context.Context, userID string) (*CreditBalance, error)
	ListCreditPacks(ctx context.Context) ([]CreditPack, error)
	ListTransactions(ctx context.Context, userID string, req ListTransactionsRequest) (*CreditTransactionPage, error)
	CreateCheckoutSession(ctx context.Context, userID string, req CreateCheckoutSessionRequest) (*CheckoutSession, error)
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
