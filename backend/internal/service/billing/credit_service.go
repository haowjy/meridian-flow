package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"

	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
)

const (
	defaultTransactionLimit = 50
	maxTransactionLimit     = 100
)

var _ billing.CreditService = (*creditService)(nil)

type creditService struct {
	store        billing.CreditStore
	stripeClient billing.StripeClient
	logger       *slog.Logger
}

func NewCreditService(
	store billing.CreditStore,
	stripeClient billing.StripeClient,
	logger *slog.Logger,
) *creditService {
	if logger == nil {
		logger = slog.Default()
	}

	return &creditService{
		store:        store,
		stripeClient: stripeClient,
		logger:       logger,
	}
}

func (s *creditService) GetBalance(ctx context.Context, userID string) (*billing.CreditBalance, error) {
	return s.store.GetBalance(ctx, userID)
}

func (s *creditService) ListCreditPacks(ctx context.Context) ([]billing.CreditPack, error) {
	_ = ctx
	packs := make([]billing.CreditPack, len(billing.CreditPacks))
	copy(packs, billing.CreditPacks)
	return packs, nil
}

func (s *creditService) ListTransactions(
	ctx context.Context,
	userID string,
	req billing.ListTransactionsRequest,
) (*billing.CreditTransactionPage, error) {
	if req.Limit == 0 {
		req.Limit = defaultTransactionLimit
	}

	if err := validation.ValidateStruct(&req,
		validation.Field(&req.Limit, validation.Required, validation.Min(1), validation.Max(maxTransactionLimit)),
		validation.Field(&req.Offset, validation.Min(0)),
	); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	return s.store.ListTransactions(ctx, userID, req)
}

func (s *creditService) CreateCheckoutSession(
	ctx context.Context,
	userID string,
	req billing.CreateCheckoutSessionRequest,
) (*billing.CheckoutSession, error) {
	if err := validation.ValidateStruct(&req,
		validation.Field(&req.PackID, validation.Required),
		validation.Field(&req.SuccessURL, validation.Required),
		validation.Field(&req.CancelURL, validation.Required),
	); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	// Validate redirect URLs to prevent open redirects via Stripe's domain.
	// Only allow URLs with http/https scheme pointing to the same origin.
	for _, u := range []struct {
		name string
		raw  string
	}{
		{"success_url", req.SuccessURL},
		{"cancel_url", req.CancelURL},
	} {
		parsed, err := url.Parse(u.raw)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, domain.NewValidationErrorWithField("invalid URL scheme", u.name)
		}
		// Block absolute URLs to external domains. Allow relative paths and localhost variants.
		host := strings.ToLower(parsed.Hostname())
		if host != "" && host != "localhost" && host != "127.0.0.1" && !strings.HasSuffix(host, ".meridian.app") {
			return nil, domain.NewValidationErrorWithField("redirect URL must point to a Meridian domain", u.name)
		}
	}

	pack, ok := findCreditPack(req.PackID)
	if !ok {
		return nil, domain.NewValidationErrorWithField("invalid pack_id", "pack_id")
	}

	stripeSession, err := s.stripeClient.CreateCheckoutSession(ctx, billing.CreateStripeSessionRequest{
		UserID:      userID,
		PackID:      pack.PackID,
		PackLabel:   pack.Label,
		PriceCents:  pack.PriceCents,
		Credits:     pack.Credits,
		SuccessURL:  req.SuccessURL,
		CancelURL:   req.CancelURL,
		CurrencyISO: "usd",
	})
	if err != nil {
		return nil, fmt.Errorf("create stripe checkout session: %w", err)
	}

	return &billing.CheckoutSession{
		SessionID:   stripeSession.ID,
		CheckoutURL: stripeSession.URL,
		ExpiresAt:   stripeSession.ExpiresAt,
	}, nil
}

func (s *creditService) HandleStripeWebhook(ctx context.Context, req billing.StripeWebhookRequest) error {
	if err := validation.ValidateStruct(&req,
		validation.Field(&req.Payload, validation.Required),
		validation.Field(&req.Signature, validation.Required),
	); err != nil {
		return domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	event, err := s.stripeClient.ConstructWebhookEvent(req.Payload, req.Signature)
	if err != nil {
		return fmt.Errorf("construct stripe webhook event: %w", err)
	}

	switch event.Type {
	case billing.StripeEventTypeCheckoutSessionCompleted:
		return s.handleCheckoutSessionCompletedWebhook(ctx, event)
	case billing.StripeEventTypeChargeRefunded, billing.StripeEventTypeChargeDisputeCreated:
		return s.handleRefundOrDisputeWebhook(ctx, event)
	default:
		return nil
	}
}

func (s *creditService) handleCheckoutSessionCompletedWebhook(
	ctx context.Context,
	event *billing.StripeEvent,
) error {

	if event.SessionID == "" {
		return domain.NewValidationError("stripe webhook missing session id")
	}

	session, err := s.stripeClient.RetrieveSession(ctx, event.SessionID)
	if err != nil {
		return fmt.Errorf("retrieve stripe session %s: %w", event.SessionID, err)
	}
	if session == nil {
		return domain.NewValidationError("stripe session not found")
	}

	if session.PaymentStatus != "paid" {
		return domain.NewValidationError("stripe session is not paid")
	}
	if session.Mode != "payment" {
		return domain.NewValidationError("stripe session mode must be payment")
	}

	userID := session.Metadata["user_id"]
	packID := session.Metadata["pack_id"]
	if userID == "" || packID == "" {
		return domain.NewValidationError("stripe session metadata missing user_id or pack_id")
	}

	pack, ok := findCreditPack(packID)
	if !ok {
		return domain.NewValidationError("stripe session metadata has unknown pack_id")
	}

	if session.AmountTotalCents != pack.PriceCents {
		return domain.NewValidationError("stripe session amount does not match pack price")
	}

	purchaseExpiresAt := time.Now().UTC().AddDate(0, 0, billing.PurchasedCreditExpirationDays)
	if err := s.store.CreatePurchaseLot(ctx, billing.CreatePurchaseLotRequest{
		UserID:             userID,
		AmountMillicredits: (pack.Credits + pack.BonusCredits) * 1000,
		StripeSessionID:    session.ID,
		ExpiresAt:          &purchaseExpiresAt,
		Metadata: billing.JSONMap{
			"pack_id":               pack.PackID,
			"pack_label":            pack.Label,
			"credits":               pack.Credits,
			"bonus_credits":         pack.BonusCredits,
			"stripe_event_id":       event.ID,
			"stripe_payment_status": session.PaymentStatus,
		},
	}); err != nil {
		return fmt.Errorf("create purchase lot from stripe session %s: %w", session.ID, err)
	}

	s.logger.Info("processed stripe checkout session",
		"session_id", session.ID,
		"user_id", userID,
		"pack_id", pack.PackID,
	)

	return nil
}

func (s *creditService) handleRefundOrDisputeWebhook(
	ctx context.Context,
	event *billing.StripeEvent,
) error {
	if event.ChargeID == "" && event.PaymentIntentID == "" {
		return domain.NewValidationError("stripe webhook missing charge id and payment intent id")
	}

	session, err := s.stripeClient.RetrieveSessionByChargeOrPaymentIntent(
		ctx,
		event.ChargeID,
		event.PaymentIntentID,
	)
	if err != nil {
		return fmt.Errorf(
			"retrieve checkout session by charge/payment intent for event %s: %w",
			event.Type,
			err,
		)
	}
	if session == nil || session.ID == "" {
		s.logger.Warn("stripe refund/dispute event has no checkout session mapping",
			"event_type", event.Type,
			"event_id", event.ID,
			"charge_id", event.ChargeID,
			"payment_intent_id", event.PaymentIntentID,
		)
		return nil
	}

	if err := s.store.RefundLot(ctx, billing.RefundLotRequest{
		StripeSessionID: session.ID,
		Metadata: billing.JSONMap{
			"stripe_event_id":       event.ID,
			"stripe_event_type":     event.Type,
			"stripe_charge_id":      event.ChargeID,
			"stripe_payment_intent": event.PaymentIntentID,
		},
	}); err != nil {
		if errors.Is(err, billing.ErrRefundLotNotFound) {
			s.logger.Warn("stripe refund/dispute event has no matching billing lot",
				"event_type", event.Type,
				"event_id", event.ID,
				"checkout_session_id", session.ID,
			)
			return nil
		}
		return fmt.Errorf("refund purchase lot for checkout session %s: %w", session.ID, err)
	}

	s.logger.Info("processed stripe refund/dispute event",
		"event_type", event.Type,
		"event_id", event.ID,
		"checkout_session_id", session.ID,
	)

	return nil
}

func findCreditPack(packID string) (*billing.CreditPack, bool) {
	for i := range billing.CreditPacks {
		if billing.CreditPacks[i].PackID == packID {
			return &billing.CreditPacks[i], true
		}
	}

	return nil, false
}
