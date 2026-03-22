package billing

import (
	"context"
	"io"
	"log/slog"
	"testing"

	billing "meridian/internal/domain/billing"
)

type mockStripeClient struct {
	event               *billing.StripeEvent
	eventErr            error
	retrieveSession     *billing.StripeSession
	retrieveSessionErr  error
	retrieveByRef       *billing.StripeSession
	retrieveByRefErr    error
	lastSessionID       string
	lastChargeID        string
	lastPaymentIntentID string
}

func (m *mockStripeClient) CreateCheckoutSession(
	ctx context.Context,
	req billing.CreateStripeSessionRequest,
) (*billing.StripeSession, error) {
	_ = ctx
	_ = req
	return nil, nil
}

func (m *mockStripeClient) ConstructWebhookEvent(payload []byte, signature string) (*billing.StripeEvent, error) {
	_ = payload
	_ = signature
	return m.event, m.eventErr
}

func (m *mockStripeClient) RetrieveSession(ctx context.Context, sessionID string) (*billing.StripeSession, error) {
	_ = ctx
	m.lastSessionID = sessionID
	return m.retrieveSession, m.retrieveSessionErr
}

func (m *mockStripeClient) RetrieveSessionByChargeOrPaymentIntent(
	ctx context.Context,
	chargeID string,
	paymentIntentID string,
) (*billing.StripeSession, error) {
	_ = ctx
	m.lastChargeID = chargeID
	m.lastPaymentIntentID = paymentIntentID
	return m.retrieveByRef, m.retrieveByRefErr
}

func TestCreditService_HandleStripeWebhook_ChargeRefundedRefundsLot(t *testing.T) {
	store := &mockCreditStore{}
	stripeClient := &mockStripeClient{
		event: &billing.StripeEvent{
			ID:              "evt_refund",
			Type:            billing.StripeEventTypeChargeRefunded,
			ChargeID:        "ch_123",
			PaymentIntentID: "pi_123",
		},
		retrieveByRef: &billing.StripeSession{
			ID: "cs_refund",
		},
	}
	svc := NewCreditService(store, stripeClient, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.HandleStripeWebhook(context.Background(), billing.StripeWebhookRequest{
		Payload:   []byte(`{}`),
		Signature: "sig",
	})
	if err != nil {
		t.Fatalf("HandleStripeWebhook returned error: %v", err)
	}

	if stripeClient.lastChargeID != "ch_123" || stripeClient.lastPaymentIntentID != "pi_123" {
		t.Fatalf("RetrieveSessionByChargeOrPaymentIntent args = (%q, %q), want (%q, %q)",
			stripeClient.lastChargeID, stripeClient.lastPaymentIntentID, "ch_123", "pi_123")
	}
	if store.lastRefundReq.StripeSessionID != "cs_refund" {
		t.Fatalf("RefundLot session_id = %q, want %q", store.lastRefundReq.StripeSessionID, "cs_refund")
	}
	if got := store.lastRefundReq.Metadata["stripe_event_type"]; got != billing.StripeEventTypeChargeRefunded {
		t.Fatalf("refund metadata stripe_event_type = %v, want %s", got, billing.StripeEventTypeChargeRefunded)
	}
}

func TestCreditService_HandleStripeWebhook_ChargeDisputeCreatedRefundsLot(t *testing.T) {
	store := &mockCreditStore{}
	stripeClient := &mockStripeClient{
		event: &billing.StripeEvent{
			ID:              "evt_dispute",
			Type:            billing.StripeEventTypeChargeDisputeCreated,
			ChargeID:        "ch_dispute",
			PaymentIntentID: "pi_dispute",
		},
		retrieveByRef: &billing.StripeSession{
			ID: "cs_dispute",
		},
	}
	svc := NewCreditService(store, stripeClient, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.HandleStripeWebhook(context.Background(), billing.StripeWebhookRequest{
		Payload:   []byte(`{}`),
		Signature: "sig",
	})
	if err != nil {
		t.Fatalf("HandleStripeWebhook returned error: %v", err)
	}

	if store.lastRefundReq.StripeSessionID != "cs_dispute" {
		t.Fatalf("RefundLot session_id = %q, want %q", store.lastRefundReq.StripeSessionID, "cs_dispute")
	}
}

func TestCreditService_HandleStripeWebhook_ChargeRefundedMissingLotIsNoop(t *testing.T) {
	store := &mockCreditStore{
		refundErr: billing.ErrRefundLotNotFound,
	}
	stripeClient := &mockStripeClient{
		event: &billing.StripeEvent{
			ID:              "evt_refund",
			Type:            billing.StripeEventTypeChargeRefunded,
			ChargeID:        "ch_123",
			PaymentIntentID: "pi_123",
		},
		retrieveByRef: &billing.StripeSession{
			ID: "cs_refund",
		},
	}
	svc := NewCreditService(store, stripeClient, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.HandleStripeWebhook(context.Background(), billing.StripeWebhookRequest{
		Payload:   []byte(`{}`),
		Signature: "sig",
	})
	if err != nil {
		t.Fatalf("HandleStripeWebhook returned error: %v", err)
	}
}

func TestCreditService_HandleStripeWebhook_CheckoutSessionCompleted_IncludesBonusCredits(t *testing.T) {
	testCases := []string{"writer", "novelist"}

	for _, packID := range testCases {
		t.Run(packID, func(t *testing.T) {
			pack, ok := findCreditPack(packID)
			if !ok {
				t.Fatalf("credit pack %q not found", packID)
			}

			store := &mockCreditStore{}
			stripeClient := &mockStripeClient{
				event: &billing.StripeEvent{
					ID:        "evt_checkout",
					Type:      billing.StripeEventTypeCheckoutSessionCompleted,
					SessionID: "cs_completed",
				},
				retrieveSession: &billing.StripeSession{
					ID:               "cs_completed",
					PaymentStatus:    "paid",
					Mode:             "payment",
					AmountTotalCents: pack.PriceCents,
					Metadata: map[string]string{
						"user_id": "user-1",
						"pack_id": packID,
					},
				},
			}
			svc := NewCreditService(store, stripeClient, slog.New(slog.NewTextHandler(io.Discard, nil)))

			err := svc.HandleStripeWebhook(context.Background(), billing.StripeWebhookRequest{
				Payload:   []byte(`{}`),
				Signature: "sig",
			})
			if err != nil {
				t.Fatalf("HandleStripeWebhook returned error: %v", err)
			}

			wantAmount := (pack.Credits + pack.BonusCredits) * 1000
			if store.lastCreatePurchaseReq.AmountMillicredits != wantAmount {
				t.Fatalf("AmountMillicredits = %d, want %d", store.lastCreatePurchaseReq.AmountMillicredits, wantAmount)
			}
			if credits, ok := store.lastCreatePurchaseReq.Metadata["credits"].(int64); !ok || credits != pack.Credits {
				t.Fatalf("metadata credits = %v, want %d", store.lastCreatePurchaseReq.Metadata["credits"], pack.Credits)
			}
			if bonus, ok := store.lastCreatePurchaseReq.Metadata["bonus_credits"].(int64); !ok || bonus != pack.BonusCredits {
				t.Fatalf("metadata bonus_credits = %v, want %d", store.lastCreatePurchaseReq.Metadata["bonus_credits"], pack.BonusCredits)
			}
		})
	}
}

func TestCreditPacksIncludeBonusForPremiumPacks(t *testing.T) {
	packs := map[string]int64{}
	for _, pack := range billing.CreditPacks {
		packs[pack.PackID] = pack.BonusCredits
	}

	if packs["writer"] <= 0 {
		t.Fatalf("writer pack should include bonus credits")
	}
	if packs["novelist"] <= 0 {
		t.Fatalf("novelist pack should include bonus credits")
	}
}
