package billing

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	billing "meridian/internal/domain/billing"
)

func TestCreditSettler_SettleAuthoritativeRequest_WriteAheadThenConsume(t *testing.T) {
	callOrder := []string{}
	store := &mockCreditStore{callOrder: &callOrder}
	generationStore := &mockGenerationBillingStore{callOrder: &callOrder}
	pricing := billing.ModelPricing{
		InputMicrousdPer1K:     2500,
		OutputMicrousdPer1K:    10000,
		ReasoningMicrousdPer1K: 10000,
		CachedMicrousdPer1K:    1250,
		MarkupBasisPoints:      1500,
	}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{
		pricingByProviderModel: map[string]billing.ModelPricing{
			"openrouter:gpt-4o": pricing,
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	req := billing.SettleRequestInput{
		UserID:          "user-1",
		TurnID:          "turn-1",
		RequestIndex:    2,
		Provider:        "openrouter",
		Model:           "gpt-4o",
		InputTokens:     100,
		OutputTokens:    200,
		ReasoningTokens: 50,
		CachedTokens:    10,
	}

	if err := svc.SettleAuthoritativeRequest(context.Background(), req); err != nil {
		t.Fatalf("SettleAuthoritativeRequest returned error: %v", err)
	}

	if len(callOrder) < 2 {
		t.Fatalf("expected at least two calls, got %v", callOrder)
	}
	if callOrder[0] != "set" || callOrder[1] != "consume" {
		t.Fatalf("expected write-ahead order [set, consume], got %v", callOrder)
	}

	if len(generationStore.setCalls) != 1 {
		t.Fatalf("SetBillingFields calls = %d, want 1", len(generationStore.setCalls))
	}
	fields := generationStore.setCalls[0]
	wantUsageEventID := "turn-1:2"
	if fields.UsageEventID != wantUsageEventID {
		t.Fatalf("UsageEventID = %q, want %q", fields.UsageEventID, wantUsageEventID)
	}
	wantGroup := mustConsumptionGroup(wantUsageEventID)
	if fields.ConsumptionGroupID != wantGroup {
		t.Fatalf("ConsumptionGroupID = %s, want %s", fields.ConsumptionGroupID, wantGroup)
	}

	if len(store.consumeCalls) != 1 {
		t.Fatalf("ConsumeFIFO calls = %d, want 1", len(store.consumeCalls))
	}
	consumeReq := store.consumeCalls[0]
	if consumeReq.UsageEventID != wantUsageEventID {
		t.Fatalf("ConsumeFIFO usage_event_id = %q, want %q", consumeReq.UsageEventID, wantUsageEventID)
	}
	if consumeReq.ConsumptionGroupID != wantGroup {
		t.Fatalf("ConsumeFIFO consumption_group_id = %s, want %s", consumeReq.ConsumptionGroupID, wantGroup)
	}

	wantAmount := billing.CalculateCreditCost(pricing, billing.TokenUsage{
		InputTokens:     req.InputTokens,
		OutputTokens:    req.OutputTokens,
		ReasoningTokens: req.ReasoningTokens,
		CachedTokens:    req.CachedTokens,
	})
	if consumeReq.AmountMillicredits != wantAmount {
		t.Fatalf("ConsumeFIFO amount = %d, want %d", consumeReq.AmountMillicredits, wantAmount)
	}

	if len(generationStore.markCalls) != 1 || generationStore.markCalls[0].Status != billingStatusSettled {
		t.Fatalf("expected settled mark status, got %+v", generationStore.markCalls)
	}
}

func TestCreditSettler_SettleAuthoritativeRequest_DeterministicIDsOnRetry(t *testing.T) {
	store := &mockCreditStore{}
	generationStore := &mockGenerationBillingStore{}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{
		pricingByProviderModel: map[string]billing.ModelPricing{
			"openrouter:gpt-4o-mini": {
				InputMicrousdPer1K:     150,
				OutputMicrousdPer1K:    600,
				ReasoningMicrousdPer1K: 600,
				CachedMicrousdPer1K:    75,
				MarkupBasisPoints:      1500,
			},
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	req := billing.SettleRequestInput{
		UserID:       "user-1",
		TurnID:       "turn-5",
		RequestIndex: 1,
		Provider:     "openrouter",
		Model:        "gpt-4o-mini",
	}

	if err := svc.SettleAuthoritativeRequest(context.Background(), req); err != nil {
		t.Fatalf("first SettleAuthoritativeRequest returned error: %v", err)
	}
	if err := svc.SettleAuthoritativeRequest(context.Background(), req); err != nil {
		t.Fatalf("second SettleAuthoritativeRequest returned error: %v", err)
	}

	if len(store.consumeCalls) != 2 {
		t.Fatalf("ConsumeFIFO calls = %d, want 2", len(store.consumeCalls))
	}
	if store.consumeCalls[0].UsageEventID != store.consumeCalls[1].UsageEventID {
		t.Fatalf("usage_event_id changed across retries: %q vs %q", store.consumeCalls[0].UsageEventID, store.consumeCalls[1].UsageEventID)
	}
	if store.consumeCalls[0].ConsumptionGroupID != store.consumeCalls[1].ConsumptionGroupID {
		t.Fatalf("consumption_group_id changed across retries: %s vs %s", store.consumeCalls[0].ConsumptionGroupID, store.consumeCalls[1].ConsumptionGroupID)
	}
}

func TestCreditSettler_SettleAuthoritativeRequest_ConsumeFailureMarksPending(t *testing.T) {
	store := &mockCreditStore{consumeErr: errors.New("db timeout")}
	generationStore := &mockGenerationBillingStore{}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{
		pricingByProviderModel: map[string]billing.ModelPricing{
			"openrouter:gpt-4o": {
				InputMicrousdPer1K:     2500,
				OutputMicrousdPer1K:    10000,
				ReasoningMicrousdPer1K: 10000,
				CachedMicrousdPer1K:    1250,
				MarkupBasisPoints:      1500,
			},
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.SettleAuthoritativeRequest(context.Background(), billing.SettleRequestInput{
		UserID:       "user-1",
		TurnID:       "turn-1",
		RequestIndex: 0,
		Provider:     "openrouter",
		Model:        "gpt-4o",
	})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	if len(generationStore.markCalls) != 1 {
		t.Fatalf("mark calls = %d, want 1", len(generationStore.markCalls))
	}
	if generationStore.markCalls[0].Status != billingStatusPending {
		t.Fatalf("status = %q, want %q", generationStore.markCalls[0].Status, billingStatusPending)
	}
}

func TestCreditSettler_RetryPendingSettlement_HappyPath(t *testing.T) {
	store := &mockCreditStore{}
	generationStore := &mockGenerationBillingStore{
		fields: &billing.BillingFields{
			UserID:             "user-1",
			UsageEventID:       "turn-9:3",
			ConsumptionGroupID: mustConsumptionGroup("turn-9:3"),
			AmountMillicredits: 4321,
			RetryCount:         2,
		},
	}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := svc.RetryPendingSettlement(context.Background(), billing.RetryPendingSettlementInput{TurnID: "turn-9", RequestIndex: 3}); err != nil {
		t.Fatalf("RetryPendingSettlement returned error: %v", err)
	}

	if len(store.consumeCalls) != 1 {
		t.Fatalf("ConsumeFIFO calls = %d, want 1", len(store.consumeCalls))
	}
	if store.consumeCalls[0].UserID != "user-1" {
		t.Fatalf("ConsumeFIFO user_id = %q, want %q", store.consumeCalls[0].UserID, "user-1")
	}
	if len(generationStore.markCalls) != 1 || generationStore.markCalls[0].Status != billingStatusSettled {
		t.Fatalf("expected settled mark status, got %+v", generationStore.markCalls)
	}
}

func TestCreditSettler_RetryPendingSettlement_MaxRetryExceeded(t *testing.T) {
	store := &mockCreditStore{consumeErr: errors.New("transient db failure")}
	generationStore := &mockGenerationBillingStore{
		fields: &billing.BillingFields{
			UserID:             "user-1",
			UsageEventID:       "turn-3:1",
			ConsumptionGroupID: mustConsumptionGroup("turn-3:1"),
			AmountMillicredits: 100,
			RetryCount:         maxSettlementRetries - 1,
		},
	}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := svc.RetryPendingSettlement(context.Background(), billing.RetryPendingSettlementInput{TurnID: "turn-3", RequestIndex: 1})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	if len(generationStore.setCalls) == 0 {
		t.Fatalf("expected retry-state persistence via SetBillingFields")
	}
	updated := generationStore.setCalls[len(generationStore.setCalls)-1]
	if updated.RetryCount != maxSettlementRetries {
		t.Fatalf("RetryCount = %d, want %d", updated.RetryCount, maxSettlementRetries)
	}
	if updated.Status != billingStatusFailed {
		t.Fatalf("Status = %q, want %q", updated.Status, billingStatusFailed)
	}
	if len(generationStore.markCalls) == 0 || generationStore.markCalls[len(generationStore.markCalls)-1].Status != billingStatusFailed {
		t.Fatalf("expected final mark status failed, got %+v", generationStore.markCalls)
	}
}

func TestCreditSettler_SettleAuthoritativeRequest_UsesFallbackPricingForUnknownModel(t *testing.T) {
	store := &mockCreditStore{}
	generationStore := &mockGenerationBillingStore{}
	svc := NewCreditSettler(store, generationStore, &mockPricingResolver{
		errByProviderModel: map[string]error{
			"openrouter:openrouter/unknown-model-id": errors.New("model not found"),
		},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	req := billing.SettleRequestInput{
		UserID:          "user-1",
		TurnID:          "turn-unknown-model",
		RequestIndex:    0,
		Provider:        "openrouter",
		Model:           "openrouter/unknown-model-id",
		InputTokens:     100,
		OutputTokens:    100,
		ReasoningTokens: 100,
		CachedTokens:    100,
	}

	if err := svc.SettleAuthoritativeRequest(context.Background(), req); err != nil {
		t.Fatalf("SettleAuthoritativeRequest returned error: %v", err)
	}

	if len(store.consumeCalls) != 1 {
		t.Fatalf("ConsumeFIFO calls = %d, want 1", len(store.consumeCalls))
	}

	wantAmount := billing.CalculateCreditCost(billing.FallbackModelPricing, billing.TokenUsage{
		InputTokens:     req.InputTokens,
		OutputTokens:    req.OutputTokens,
		ReasoningTokens: req.ReasoningTokens,
		CachedTokens:    req.CachedTokens,
	})
	if store.consumeCalls[0].AmountMillicredits != wantAmount {
		t.Fatalf("fallback amount = %d, want %d", store.consumeCalls[0].AmountMillicredits, wantAmount)
	}
}

func TestCreditSettler_MarkPendingSettlement_PersistsDeterministicMarker(t *testing.T) {
	generationStore := &mockGenerationBillingStore{}
	svc := NewCreditSettler(&mockCreditStore{}, generationStore, &mockPricingResolver{}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	req := billing.MarkPendingSettlementInput{
		UserID:       "user-1",
		TurnID:       "turn-2",
		RequestIndex: 4,
		Model:        "gpt-4o",
		LastError:    "interrupted_stream",
	}
	if err := svc.MarkPendingSettlement(context.Background(), req); err != nil {
		t.Fatalf("MarkPendingSettlement returned error: %v", err)
	}

	if len(generationStore.setCalls) != 1 {
		t.Fatalf("SetBillingFields calls = %d, want 1", len(generationStore.setCalls))
	}
	fields := generationStore.setCalls[0]
	if fields.Status != billingStatusPending {
		t.Fatalf("Status = %q, want %q", fields.Status, billingStatusPending)
	}
	if fields.LastError != req.LastError {
		t.Fatalf("LastError = %q, want %q", fields.LastError, req.LastError)
	}
	wantUsageEventID := "turn-2:4"
	if fields.UsageEventID != wantUsageEventID {
		t.Fatalf("UsageEventID = %q, want %q", fields.UsageEventID, wantUsageEventID)
	}
	if fields.ConsumptionGroupID != mustConsumptionGroup(wantUsageEventID) {
		t.Fatalf("ConsumptionGroupID = %s, want %s", fields.ConsumptionGroupID, mustConsumptionGroup(wantUsageEventID))
	}
}
