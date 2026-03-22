package streaming

import (
	"context"
	"fmt"
	"strings"
	"time"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/tokens"
)

// setGenerationID stores the generation ID (thread-safe for reads from other goroutines).
func (se *StreamExecutor) setGenerationID(id string) {
	se.generationMu.Lock()
	se.generationID = id
	se.generationMu.Unlock()
}

// getGenerationID returns the stored generation ID (thread-safe).
func (se *StreamExecutor) getGenerationID() string {
	se.generationMu.RLock()
	defer se.generationMu.RUnlock()
	return se.generationID
}

// updateTurnMetadata updates the turn with final metadata.
// Accumulates tokens (adds to existing) and overwrites other metadata atomically.
func (se *StreamExecutor) updateTurnMetadata(ctx context.Context, metadata *domainllm.StreamMetadata) error {
	return se.turnWriter.AccumulateTokensAndUpdateMetadata(ctx, se.turnID,
		&domainllm.TurnTokenUpdate{
			InputTokens:  metadata.InputTokens,
			OutputTokens: metadata.OutputTokens,
		},
		&domainllm.TurnCompletionUpdate{
			Model:            &metadata.Model,
			StopReason:       &metadata.StopReason,
			ResponseMetadata: metadata.ResponseMetadata,
		},
	)
}

// persistTokenMetadata is a helper to persist token counts from TokenFinalizer.
// It centralizes the response_metadata structure and reason handling across timeout/error paths.
// Accumulates tokens (adds to existing) atomically with metadata update.
// For normal completion, use updateTurnMetadata() which handles full StreamMetadata.
func (se *StreamExecutor) persistTokenMetadata(ctx context.Context, result *tokens.TokenResult, reason string) error {
	if result == nil || (result.InputTokens == 0 && result.OutputTokens == 0) {
		return nil // Skip if no tokens to persist
	}

	// Build response_metadata with consistent fields
	responseMeta := map[string]interface{}{
		"token_metadata_final": result.IsFinal,
		"token_source":         result.Source,
	}
	// Only include reason if non-empty (avoids empty "reason":"" in JSON)
	if reason != "" {
		responseMeta["reason"] = reason
	}

	// Atomically accumulate tokens and update metadata
	// Note: StopReason is nil (keep existing) since this is partial/error recovery
	// Model is updated to ensure it's captured even on early termination
	model := se.model
	return se.turnWriter.AccumulateTokensAndUpdateMetadata(ctx, se.turnID,
		&domainllm.TurnTokenUpdate{
			InputTokens:  result.InputTokens,
			OutputTokens: result.OutputTokens,
		},
		&domainllm.TurnCompletionUpdate{
			Model:            &model,
			StopReason:       nil, // Keep existing stop_reason (intentional)
			ResponseMetadata: responseMeta,
		},
	)
}

// persistGenerationRecord persists an OpenRouter generation record to response_metadata.
// This captures provider name, native tokens, and cost for each LLM request (initial + tool continuations).
// Generation records are stored in response_metadata.openrouter.generations[] array.
func (se *StreamExecutor) persistGenerationRecord(ctx context.Context, metadata *domainllm.StreamMetadata) error {
	// Check if we have a generation ID
	generationID := se.getGenerationID()
	if generationID == "" {
		return nil // Not OpenRouter or no generation ID captured
	}

	// Determine phase based on tool iteration (0 = initial, 1+ = tool_continue)
	phase := "initial"
	if se.toolIteration > 0 {
		phase = "tool_continue"
	}

	// Try to query generation stats if provider supports it (capability interface)
	// This follows DIP - we depend on interface, not concrete type
	statsQuerier, ok := se.provider.(domainllm.GenerationStatsQuerier)
	if !ok {
		// Provider doesn't support stats API - finalize with available metadata
		// This ensures records are always finalized, even without enrichment
		basicRecord := &domainllm.GenerationRecord{
			ID:           generationID,
			RequestIndex: se.requestIndex,
			Phase:        phase,
			Model:        metadata.Model,
			Finalized:    true, // Finalized without enrichment
		}

		if err := se.turnWriter.AppendGenerationRecord(ctx, se.turnID, basicRecord); err != nil {
			return fmt.Errorf("failed to append basic generation record: %w", err)
		}

		se.logger.Debug("persisted basic generation record (no stats API)",
			"turn_id", se.turnID,
			"generation_id", generationID,
			"request_index", se.requestIndex,
			"phase", phase,
			"model", metadata.Model,
		)
		return nil
	}

	// Provider supports stats API - query with timeout
	// Use tight timeout to avoid blocking tool continuations
	apiCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	stats, err := statsQuerier.QueryGenerationStats(apiCtx, generationID)
	if err != nil {
		// Check if this is a 404 "not found" error (OpenRouter eventual consistency)
		if strings.Contains(err.Error(), "HTTP 404") || strings.Contains(err.Error(), "not found") {
			se.logger.Debug("generation stats not yet available, enqueuing background job",
				"turn_id", se.turnID,
				"generation_id", generationID,
				"request_index", se.requestIndex,
				"phase", phase,
				"model", metadata.Model,
				"error", err,
			)

			// Enqueue background job for retry with exponential backoff
			if se.jobQueue != nil { // nil check for backward compatibility
				job := jobs.NewEnrichGenerationJob(
					se.turnID,
					generationID,
					se.requestIndex,
					phase,
					metadata.Model,
					se.userID,
					se.provider.Name(),
					se.turnWriter,
					statsQuerier,
					se.creditSettler,
					se.settlementMode,
					se.logger,
					false, // isCancelled: false for normal completion
				)
				if err := se.jobQueue.Enqueue(job); err != nil {
					se.logger.Error("failed to enqueue generation enrichment job",
						"error", err,
						"turn_id", se.turnID,
						"generation_id", generationID,
					)
				}
			}

			// Note: Partial record already exists from processGenerationIDDiscovered()
			// Job will upgrade it to finalized=true when successful
			return nil
		}

		// Other errors (auth, network, etc.) - finalize immediately with error
		basicRecord := &domainllm.GenerationRecord{
			ID:                generationID,
			RequestIndex:      se.requestIndex,
			Phase:             phase,
			Model:             metadata.Model,
			Finalized:         true,
			FinalizeAttempts:  1,
			FinalizeLastError: err.Error(),
		}

		if err := se.turnWriter.AppendGenerationRecord(ctx, se.turnID, basicRecord); err != nil {
			return fmt.Errorf("failed to append basic generation record: %w", err)
		}

		se.logger.Warn("non-retryable error querying generation stats",
			"error", err,
			"turn_id", se.turnID,
			"generation_id", generationID,
			"request_index", se.requestIndex,
			"phase", phase,
			"model", metadata.Model,
		)
		return nil
	}

	// Success - enrich and finalize with complete API data
	enrichedRecord := &domainllm.GenerationRecord{
		ID:                     stats.ID,
		RequestIndex:           se.requestIndex,
		Phase:                  phase,
		Model:                  stats.Model,
		ProviderName:           stats.ProviderName,
		NativeTokensPrompt:     stats.NativeTokensPrompt,
		NativeTokensCompletion: stats.NativeTokensCompletion,
		NativeTokensReasoning:  stats.NativeTokensReasoning,
		NativeTokensCached:     stats.NativeTokensCached,
		TotalCost:              stats.TotalCost,
		FinishReason:           stats.FinishReason,
		CreatedAt:              stats.CreatedAt,
		UpstreamID:             stats.UpstreamID,
		Latency:                stats.Latency,
		Cancelled:              stats.Cancelled,
		Finalized:              true,                   // Successfully enriched with API data
		AdditionalFields:       stats.AdditionalFields, // Forward compatibility: preserve unknown fields
	}

	// Persist to database (atomic JSONB upsert-by-id)
	if err := se.turnWriter.AppendGenerationRecord(ctx, se.turnID, enrichedRecord); err != nil {
		return fmt.Errorf("failed to append enriched generation record: %w", err)
	}

	se.logger.Debug("persisted enriched OpenRouter generation record",
		"turn_id", se.turnID,
		"generation_id", stats.ID,
		"request_index", se.requestIndex,
		"phase", phase,
		"provider_name", stats.ProviderName,
		"native_tokens_prompt", stats.NativeTokensPrompt,
		"native_tokens_completion", stats.NativeTokensCompletion,
		"native_tokens_reasoning", stats.NativeTokensReasoning,
		"native_tokens_cached", stats.NativeTokensCached,
		"total_cost", stats.TotalCost,
		"latency_ms", stats.Latency,
	)

	return nil
}
