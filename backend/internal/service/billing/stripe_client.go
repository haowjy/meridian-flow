package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/stripe/stripe-go/v82"
	stripecharge "github.com/stripe/stripe-go/v82/charge"
	checkoutsession "github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/webhook"

	billingdomain "meridian/internal/domain/services/billing"
)

var _ billingdomain.StripeClient = (*stripeClient)(nil)

type stripeClient struct {
	webhookSecret string
}

func NewStripeClient(apiKey string, webhookSecret string) billingdomain.StripeClient {
	stripe.Key = apiKey
	return &stripeClient{webhookSecret: webhookSecret}
}

func (c *stripeClient) CreateCheckoutSession(
	ctx context.Context,
	req billingdomain.CreateStripeSessionRequest,
) (*billingdomain.StripeSession, error) {
	currency := req.CurrencyISO
	if currency == "" {
		currency = "usd"
	}

	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		SuccessURL:        stripe.String(req.SuccessURL),
		CancelURL:         stripe.String(req.CancelURL),
		ClientReferenceID: stripe.String(req.UserID),
		Metadata: map[string]string{
			"user_id": req.UserID,
			"pack_id": req.PackID,
		},
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{
				Quantity: stripe.Int64(1),
				PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{
					Currency:   stripe.String(currency),
					UnitAmount: stripe.Int64(req.PriceCents),
					ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
						Name: stripe.String(fmt.Sprintf("%s Credit Pack", req.PackLabel)),
					},
				},
			},
		},
	}

	session, err := checkoutsession.New(params)
	if err != nil {
		return nil, fmt.Errorf("create stripe checkout session: %w", err)
	}

	return mapStripeSession(session), nil
}

func (c *stripeClient) ConstructWebhookEvent(payload []byte, signature string) (*billingdomain.StripeEvent, error) {
	if c.webhookSecret == "" {
		return nil, errors.New("stripe webhook secret is not configured")
	}

	event, err := webhook.ConstructEvent(payload, signature, c.webhookSecret)
	if err != nil {
		return nil, fmt.Errorf("construct stripe event: %w", err)
	}

	stripeEvent := &billingdomain.StripeEvent{
		ID:   event.ID,
		Type: string(event.Type),
	}

	if event.Type == stripe.EventTypeCheckoutSessionCompleted {
		var session stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &session); err != nil {
			return nil, fmt.Errorf("decode checkout session from webhook event: %w", err)
		}
		stripeEvent.SessionID = session.ID
	}
	if event.Type == stripe.EventTypeChargeRefunded {
		var charge stripe.Charge
		if err := json.Unmarshal(event.Data.Raw, &charge); err != nil {
			return nil, fmt.Errorf("decode charge from refunded webhook event: %w", err)
		}
		stripeEvent.ChargeID = charge.ID
		if charge.PaymentIntent != nil {
			stripeEvent.PaymentIntentID = charge.PaymentIntent.ID
		}
	}
	if event.Type == stripe.EventTypeChargeDisputeCreated {
		var dispute stripe.Dispute
		if err := json.Unmarshal(event.Data.Raw, &dispute); err != nil {
			return nil, fmt.Errorf("decode dispute from webhook event: %w", err)
		}
		if dispute.Charge != nil {
			stripeEvent.ChargeID = dispute.Charge.ID
		}
		if dispute.PaymentIntent != nil {
			stripeEvent.PaymentIntentID = dispute.PaymentIntent.ID
		}
	}

	return stripeEvent, nil
}

func (c *stripeClient) RetrieveSession(ctx context.Context, sessionID string) (*billingdomain.StripeSession, error) {
	session, err := checkoutsession.Get(sessionID, nil)
	if err != nil {
		return nil, fmt.Errorf("retrieve stripe checkout session: %w", err)
	}

	_ = ctx
	return mapStripeSession(session), nil
}

func (c *stripeClient) RetrieveSessionByChargeOrPaymentIntent(
	ctx context.Context,
	chargeID string,
	paymentIntentID string,
) (*billingdomain.StripeSession, error) {
	paymentIntent := paymentIntentID
	if paymentIntent == "" && chargeID != "" {
		charge, err := stripecharge.Get(chargeID, nil)
		if err != nil {
			return nil, fmt.Errorf("retrieve stripe charge: %w", err)
		}
		if charge == nil || charge.PaymentIntent == nil || charge.PaymentIntent.ID == "" {
			return nil, nil
		}
		paymentIntent = charge.PaymentIntent.ID
	}
	if paymentIntent == "" {
		return nil, nil
	}

	params := &stripe.CheckoutSessionListParams{
		PaymentIntent: stripe.String(paymentIntent),
	}
	params.Limit = stripe.Int64(1)

	iter := checkoutsession.List(params)
	for iter.Next() {
		return mapStripeSession(iter.CheckoutSession()), nil
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("list stripe checkout sessions by payment intent: %w", err)
	}

	_ = ctx
	return nil, nil
}

func mapStripeSession(session *stripe.CheckoutSession) *billingdomain.StripeSession {
	if session == nil {
		return nil
	}

	amountTotal := int64(0)
	if session.AmountTotal > 0 {
		amountTotal = session.AmountTotal
	}

	expiresAt := time.Time{}
	if session.ExpiresAt > 0 {
		expiresAt = time.Unix(session.ExpiresAt, 0).UTC()
	}

	return &billingdomain.StripeSession{
		ID:                session.ID,
		URL:               session.URL,
		ExpiresAt:         expiresAt,
		PaymentStatus:     string(session.PaymentStatus),
		Mode:              string(session.Mode),
		AmountTotalCents:  amountTotal,
		ClientReferenceID: session.ClientReferenceID,
		Metadata:          session.Metadata,
	}
}
