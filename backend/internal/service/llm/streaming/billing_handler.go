package streaming

import (
	"context"
	"strconv"
	"time"

	mstream "github.com/haowjy/meridian-stream-go"

	billingmodel "meridian/internal/domain/models/billing"
	llmModels "meridian/internal/domain/models/llm"
	billingdomain "meridian/internal/domain/services/billing"
	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/jobs"
)

const (
	turnStatusCreditLimited       = "credit_limited"
	creditLimitedErrorMessage     = "insufficient credits"
	runStopReasonCreditsExhausted = "credits_exhausted"
)

// handleCreditsExhausted finalizes the run via a dedicated credit-limited path.
// This path intentionally does not use handleError, so clients get a graceful terminal state.
func (se *StreamExecutor) handleCreditsExhausted(ctx context.Context, send func(mstream.Event), requestIndex int, phase string) {
	_ = send
	_ = ctx

	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Preserve any user-visible partial content before ending the run.
	se.persistPartialBlocks(persistCtx)

	completedAt := time.Now().UTC()
	turn, err := se.turnReader.GetTurn(persistCtx, se.turnID)
	if err != nil {
		se.logger.Warn("failed to load turn while marking credit_limited",
			"turn_id", se.turnID,
			"error", err,
		)
		// Fallback still marks status terminal even if we cannot update error text.
		fallback := &llmModels.Turn{CompletedAt: &completedAt}
		if statusErr := se.turnRepo.UpdateTurnStatus(persistCtx, se.turnID, turnStatusCreditLimited, fallback); statusErr != nil {
			se.logger.Error("failed to mark turn credit_limited",
				"turn_id", se.turnID,
				"error", statusErr,
			)
		}
	} else {
		turn.Status = turnStatusCreditLimited
		turn.CompletedAt = &completedAt
		turn.Error = ptrString(creditLimitedErrorMessage)
		if updateErr := se.turnRepo.UpdateTurn(persistCtx, turn); updateErr != nil {
			se.logger.Error("failed to persist credit_limited turn state",
				"turn_id", se.turnID,
				"error", updateErr,
			)
		}
	}

	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitCreditsExhausted(requestIndex, phase)
		se.aguiEmitter.EmitRunFinished(runStopReasonCreditsExhausted, 0, 0)
	}

	se.transitionTo(StateCompleted)
	if se.onCleanup != nil {
		se.onCleanup()
	}
}

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

	req := billingdomainSettleRequestInput(provider, model, se.turnID, se.userID, se.requestIndex, metadata)
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

func (se *StreamExecutor) handleTerminalSettlement(
	ctx context.Context,
	metadata *domainllm.StreamMetadata,
	pendingReason string,
	isCancelled bool,
) {
	if metadata == nil {
		return
	}

	switch se.settlementMode {
	case billingmodel.CreditSettlementDeferredToEnrichment:
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
		se.turnRepo,
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

	req := billingdomain.MarkPendingSettlementInput{
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

func billingdomainSettleRequestInput(
	provider string,
	model string,
	turnID string,
	userID string,
	requestIndex int,
	metadata *domainllm.StreamMetadata,
) billingdomain.SettleRequestInput {
	return billingdomain.SettleRequestInput{
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
