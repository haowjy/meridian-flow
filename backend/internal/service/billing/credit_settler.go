package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	billing "meridian/internal/domain/billing"
)

const (
	billingStatusPending = "pending"
	billingStatusSettled = "settled"
	billingStatusFailed  = "failed"

	maxSettlementRetries = 5
)

var _ billing.CreditSettler = (*creditSettler)(nil)

type creditSettler struct {
	store           billing.CreditStore
	generationStore billing.GenerationBillingStore
	pricingResolver billing.ModelPricingResolver
	logger          *slog.Logger
}

func NewCreditSettler(
	store billing.CreditStore,
	generationStore billing.GenerationBillingStore,
	pricingResolver billing.ModelPricingResolver,
	logger *slog.Logger,
) *creditSettler {
	if logger == nil {
		logger = slog.Default()
	}

	return &creditSettler{
		store:           store,
		generationStore: generationStore,
		pricingResolver: pricingResolver,
		logger:          logger,
	}
}

func (s *creditSettler) SettleAuthoritativeRequest(ctx context.Context, req billing.SettleRequestInput) error {
	if req.UserID == "" {
		return errors.New("settlement user_id is required")
	}
	if req.TurnID == "" {
		return errors.New("settlement turn_id is required")
	}
	if req.RequestIndex < 0 {
		return fmt.Errorf("settlement request_index must be >= 0")
	}

	pricing := s.resolvePricing(req.Provider, req.Model, req.TurnID, req.RequestIndex)

	usageEventID := fmt.Sprintf("%s:%d", req.TurnID, req.RequestIndex)
	consumptionGroupID := uuid.NewSHA1(billing.BillingNamespace, []byte(usageEventID))
	amountMillicredits := billing.CalculateCreditCost(pricing, billing.TokenUsage{
		InputTokens:     req.InputTokens,
		OutputTokens:    req.OutputTokens,
		ReasoningTokens: req.ReasoningTokens,
		CachedTokens:    req.CachedTokens,
	})

	fields := billing.BillingFields{
		UserID:             req.UserID,
		UsageEventID:       usageEventID,
		ConsumptionGroupID: consumptionGroupID,
		AmountMillicredits: amountMillicredits,
	}

	// Write-ahead: persist deterministic settlement fields before ledger mutation.
	if err := s.generationStore.SetBillingFields(ctx, req.TurnID, req.RequestIndex, fields); err != nil {
		return fmt.Errorf("persist billing fields: %w", err)
	}

	consumeReq := billing.ConsumeFIFORequest{
		UserID:             req.UserID,
		AmountMillicredits: amountMillicredits,
		ConsumptionGroupID: consumptionGroupID,
		UsageEventID:       usageEventID,
		Metadata: billing.JSONMap{
			"turn_id":       req.TurnID,
			"request_index": req.RequestIndex,
			"model":         req.Model,
		},
	}
	if err := s.store.ConsumeFIFO(ctx, consumeReq); err != nil {
		markErr := s.generationStore.MarkBillingStatus(ctx, req.TurnID, req.RequestIndex, billingStatusPending, err.Error())
		if markErr != nil {
			return fmt.Errorf("consume fifo: %w (and failed to mark pending: %v)", err, markErr)
		}

		s.logger.Warn("billing settlement pending after consume failure",
			"turn_id", req.TurnID,
			"request_index", req.RequestIndex,
			"error", err,
		)
		return fmt.Errorf("consume fifo: %w", err)
	}

	if err := s.generationStore.MarkBillingStatus(ctx, req.TurnID, req.RequestIndex, billingStatusSettled, ""); err != nil {
		return fmt.Errorf("mark billing settled: %w", err)
	}

	return nil
}

func (s *creditSettler) MarkPendingSettlement(ctx context.Context, req billing.MarkPendingSettlementInput) error {
	if req.UserID == "" {
		return errors.New("pending settlement user_id is required")
	}
	if req.TurnID == "" {
		return errors.New("pending settlement turn_id is required")
	}
	if req.RequestIndex < 0 {
		return fmt.Errorf("pending settlement request_index must be >= 0")
	}

	usageEventID := fmt.Sprintf("%s:%d", req.TurnID, req.RequestIndex)
	fields := billing.BillingFields{
		UserID:             req.UserID,
		UsageEventID:       usageEventID,
		ConsumptionGroupID: uuid.NewSHA1(billing.BillingNamespace, []byte(usageEventID)),
		Status:             billingStatusPending,
		LastError:          req.LastError,
	}

	if err := s.generationStore.SetBillingFields(ctx, req.TurnID, req.RequestIndex, fields); err != nil {
		return fmt.Errorf("persist pending billing marker: %w", err)
	}

	return nil
}

func (s *creditSettler) RetryPendingSettlement(ctx context.Context, req billing.RetryPendingSettlementInput) error {
	if req.TurnID == "" {
		return errors.New("retry settlement turn_id is required")
	}
	if req.RequestIndex < 0 {
		return fmt.Errorf("retry settlement request_index must be >= 0")
	}

	fields, err := s.generationStore.GetBillingFields(ctx, req.TurnID, req.RequestIndex)
	if err != nil {
		return fmt.Errorf("load billing fields: %w", err)
	}
	if fields == nil {
		return errors.New("billing fields not found")
	}
	if fields.UserID == "" || fields.UsageEventID == "" || fields.ConsumptionGroupID == uuid.Nil || fields.AmountMillicredits <= 0 {
		return errors.New("billing fields incomplete for retry")
	}

	consumeReq := billing.ConsumeFIFORequest{
		UserID:             fields.UserID,
		AmountMillicredits: fields.AmountMillicredits,
		ConsumptionGroupID: fields.ConsumptionGroupID,
		UsageEventID:       fields.UsageEventID,
		Metadata: billing.JSONMap{
			"turn_id":       req.TurnID,
			"request_index": req.RequestIndex,
			"retry":         true,
		},
	}
	if err := s.store.ConsumeFIFO(ctx, consumeReq); err != nil {
		nextRetryCount := fields.RetryCount + 1
		nextStatus := billingStatusPending
		if nextRetryCount >= maxSettlementRetries {
			nextStatus = billingStatusFailed
		}

		updated := *fields
		updated.RetryCount = nextRetryCount
		updated.Status = nextStatus
		updated.LastError = err.Error()
		if setErr := s.generationStore.SetBillingFields(ctx, req.TurnID, req.RequestIndex, updated); setErr != nil {
			return fmt.Errorf("retry consume fifo: %w (and failed to persist retry state: %v)", err, setErr)
		}

		if markErr := s.generationStore.MarkBillingStatus(ctx, req.TurnID, req.RequestIndex, nextStatus, err.Error()); markErr != nil {
			return fmt.Errorf("retry consume fifo: %w (and failed to mark billing status: %v)", err, markErr)
		}

		return fmt.Errorf("retry consume fifo: %w", err)
	}

	if err := s.generationStore.MarkBillingStatus(ctx, req.TurnID, req.RequestIndex, billingStatusSettled, ""); err != nil {
		return fmt.Errorf("mark billing settled on retry: %w", err)
	}

	return nil
}

func (s *creditSettler) resolvePricing(provider string, model string, turnID string, requestIndex int) billing.ModelPricing {
	if s.pricingResolver != nil {
		pricing, err := s.pricingResolver.ResolvePricing(provider, model)
		if err == nil {
			return pricing
		}
		s.logger.Warn("billing model pricing resolution failed; using fallback pricing",
			"provider", provider,
			"model", model,
			"turn_id", turnID,
			"request_index", requestIndex,
			"error", err,
		)
		return billing.FallbackModelPricing
	}

	s.logger.Warn("billing pricing resolver not configured; using fallback pricing",
		"provider", provider,
		"model", model,
		"turn_id", turnID,
		"request_index", requestIndex,
	)
	return billing.FallbackModelPricing
}
