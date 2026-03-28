package streaming

import (
	"context"
	"strconv"

	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/jobs"
)

// settleCurrentRequest attempts authoritative settlement for the current request index.
// Settlement failures are intentionally best-effort and must not fail the user-visible turn.
func (se *StreamExecutor) settleCurrentRequest(ctx context.Context, metadata *domainllm.StreamMetadata) {
	if se.creditSettler == nil || metadata == nil {
		return
	}

	model := metadata.Model
	if model == "" {
		model = se.model
	}
	provider := ""
	if se.provider != nil {
		provider = se.provider.Name()
	}

	req := buildSettleRequestInput(provider, model, se.turnID, se.userID, se.requestIndex, metadata)
	if err := se.creditSettler.SettleAuthoritativeRequest(ctx, req); err != nil {
		se.logger.Warn("inline credit settlement failed (turn remains successful)",
			"turn_id", se.turnID,
			"request_index", se.requestIndex,
			"provider", provider,
			"model", model,
			"error", err,
		)
	}
}

func (se *StreamExecutor) handleFinalSettlement(
	ctx context.Context,
	metadata *domainllm.StreamMetadata,
	pendingReason string,
	isCancelled bool,
) {
	if metadata == nil {
		return
	}

	switch se.settlementMode {
	case billing.CreditSettlementDeferredToEnrichment:
		se.markCurrentRequestPendingSettlement(ctx, metadata.Model, pendingReason, isCancelled)
	default:
		se.settleCurrentRequest(ctx, metadata)
	}
}

func (se *StreamExecutor) markCurrentRequestPendingSettlement(
	ctx context.Context,
	model string,
	lastError string,
	isCancelled bool,
) {
	se.persistCurrentRequestPendingSettlement(ctx, model, lastError)

	generationID := se.getGenerationID()
	if generationID == "" {
		se.logger.Debug("pending settlement marker persisted without enrichment enqueue (missing generation id)",
			"turn_id", se.turnID,
			"request_index", se.requestIndex,
		)
		return
	}

	if model == "" {
		model = se.model
	}

	phase := "initial"
	if se.requestIndex > 0 {
		phase = "tool_continue"
	}

	se.enqueueEnrichmentSettlementJob(generationID, phase, model, isCancelled)
}

func (se *StreamExecutor) enqueueEnrichmentSettlementJob(
	generationID string,
	phase string,
	model string,
	isCancelled bool,
) {
	if se.jobQueue == nil {
		return
	}
	querier, ok := se.provider.(domainllm.GenerationStatsQuerier)
	if !ok {
		return
	}

	job := jobs.NewEnrichGenerationJob(
		se.turnID,
		generationID,
		se.requestIndex,
		phase,
		model,
		se.userID,
		se.provider.Name(),
		se.turnWriter,
		querier,
		se.creditSettler,
		se.settlementMode,
		se.logger,
		isCancelled,
	)
	if err := se.jobQueue.Enqueue(job); err != nil {
		se.logger.Warn("failed to enqueue enrichment settlement job",
			"turn_id", se.turnID,
			"generation_id", generationID,
			"request_index", se.requestIndex,
			"error", err,
		)
	}
}

func (se *StreamExecutor) persistCurrentRequestPendingSettlement(
	ctx context.Context,
	model string,
	lastError string,
) {
	if se.creditSettler == nil {
		return
	}
	if model == "" {
		model = se.model
	}

	req := billing.MarkPendingSettlementInput{
		UserID:       se.userID,
		TurnID:       se.turnID,
		RequestIndex: se.requestIndex,
		Model:        model,
		LastError:    lastError,
	}
	if err := se.creditSettler.MarkPendingSettlement(ctx, req); err != nil {
		se.logger.Warn("failed to persist pending billing settlement marker",
			"turn_id", se.turnID,
			"request_index", se.requestIndex,
			"error", err,
		)
	}
}

func buildSettleRequestInput(
	provider string,
	model string,
	turnID string,
	userID string,
	requestIndex int,
	metadata *domainllm.StreamMetadata,
) billing.SettleRequestInput {
	return billing.SettleRequestInput{
		UserID:          userID,
		TurnID:          turnID,
		RequestIndex:    requestIndex,
		Provider:        provider,
		Model:           model,
		InputTokens:     int64(metadata.InputTokens),
		OutputTokens:    int64(metadata.OutputTokens),
		ReasoningTokens: resolveReasoningTokens(metadata),
		CachedTokens:    resolveCachedTokens(metadata),
	}
}

func resolveReasoningTokens(metadata *domainllm.StreamMetadata) int64 {
	if metadata == nil {
		return 0
	}
	if v, ok := lookupInt64(metadata.ResponseMetadata, "reasoning_tokens", "native_tokens_reasoning"); ok {
		return v
	}

	usage, _ := metadata.ResponseMetadata["usage"].(map[string]interface{})
	if v, ok := lookupInt64(usage, "reasoning_tokens", "native_reasoning_tokens"); ok {
		return v
	}

	return 0
}

func resolveCachedTokens(metadata *domainllm.StreamMetadata) int64 {
	if metadata == nil {
		return 0
	}
	if v, ok := lookupInt64(metadata.ResponseMetadata, "cached_tokens", "native_tokens_cached"); ok {
		return v
	}

	usage, _ := metadata.ResponseMetadata["usage"].(map[string]interface{})
	if v, ok := lookupInt64(usage, "cached_tokens", "cache_read_input_tokens"); ok {
		return v
	}

	return 0
}

func lookupInt64(m map[string]interface{}, keys ...string) (int64, bool) {
	if m == nil {
		return 0, false
	}

	for _, key := range keys {
		raw, exists := m[key]
		if !exists {
			continue
		}
		if value, ok := toInt64(raw); ok {
			return value, true
		}
	}

	return 0, false
}

func toInt64(raw interface{}) (int64, bool) {
	switch v := raw.(type) {
	case int:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	case float64:
		return int64(v), true
	case string:
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	default:
		return 0, false
	}
}

func ptrString(value string) *string {
	return &value
}
