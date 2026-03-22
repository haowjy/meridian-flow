package billing

import (
	"context"
	"time"
)

const (
	StripeEventTypeCheckoutSessionCompleted = "checkout.session.completed"
	StripeEventTypeChargeRefunded           = "charge.refunded"
	StripeEventTypeChargeDisputeCreated     = "charge.dispute.created"
)

// StripeClient defines the subset of Stripe API calls used by billing services.
type StripeClient interface {
	CreateCheckoutSession(ctx context.Context, req CreateStripeSessionRequest) (*StripeSession, error)
	ConstructWebhookEvent(payload []byte, signature string) (*StripeEvent, error)
	RetrieveSession(ctx context.Context, sessionID string) (*StripeSession, error)
	RetrieveSessionByChargeOrPaymentIntent(
		ctx context.Context,
		chargeID string,
		paymentIntentID string,
	) (*StripeSession, error)
}

// CreateStripeSessionRequest is the server-authoritative checkout payload.
type CreateStripeSessionRequest struct {
	UserID      string
	PackID      string
	PackLabel   string
	PriceCents  int64
	Credits     int64
	SuccessURL  string
	CancelURL   string
	CurrencyISO string
}

// StripeSession contains normalized Stripe Checkout session details.
type StripeSession struct {
	ID                string
	URL               string
	ExpiresAt         time.Time
	PaymentStatus     string
	Mode              string
	AmountTotalCents  int64
	ClientReferenceID string
	Metadata          map[string]string
}

// StripeEvent contains normalized Stripe webhook event data.
type StripeEvent struct {
	ID              string
	Type            string
	SessionID       string
	ChargeID        string
	PaymentIntentID string
}
