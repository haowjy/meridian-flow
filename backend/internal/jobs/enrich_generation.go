package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	domainllm "meridian/internal/domain/services/llm"
)

const (
	// Retry configuration for normal completion enrichment
	// Fast retries since generation should be indexed quickly
	normalCompletionStartingBackoff = 200 * time.Millisecond
	normalCompletionMaxAttempts     = 5 // Total: ~3 seconds

	// Retry configuration for cancellation enrichment
	// Slower retries since cancelled generation may take longer to index
	cancellationStartingBackoff = 1 * time.Second
	cancellationMaxAttempts     = 10 // Total: ~8.5 minutes
)

// EnrichGenerationJob enriches OpenRouter generation records with native tokens and cost data.
// Handles eventual consistency by retrying HTTP 404 errors with exponential backoff.
//
// Retry Strategy:
// - Normal completion: 5 attempts, start at 200ms (total ~3 seconds)
// - Cancellation: 10 attempts, start at 1s (total ~8.5 minutes)
// - HTTP 404 "Generation not found": Retry with exponential backoff
// - Other errors (auth, network): Finalize immediately with error, no retry
//
// Token Accuracy Race Window (Expected Behavior):
// For reasoning-capable models (o1, Grok, DeepSeek-R1, etc.), there is a brief window
// where turn.output_tokens is incomplete:
//   1. Stream completes -> turn.output_tokens set from streaming metadata (NO reasoning tokens)
//   2. Background job runs (1s - 8.5 min later) -> adds reasoning tokens
//   3. turn.output_tokens now complete (completion + reasoning)
//
// This is ACCEPTABLE for backend tracking/billing purposes:
// - Final token counts are eventually consistent
// - Generation metadata always preserved with full details
// - UI can poll or show "finalizing..." during enrichment if needed
type EnrichGenerationJob struct {
	turnID       string
	generationID string
	requestIndex int
	phase        string
	model        string

	turnWriter llmRepo.TurnWriter
	provider   domainllm.GenerationStatsQuerier
	logger     *slog.Logger

	isCancelled  bool          // Distinguishes cancel from normal completion (affects retry timing)
	attempt      int           // Current attempt count (incremented in Execute)
	lastError    string        // Last error message (for Retryable() decision)
	backoffDelay time.Duration // Current backoff delay (doubles on each retry)
}

// NewEnrichGenerationJob creates a new generation enrichment job.
func NewEnrichGenerationJob(
	turnID string,
	generationID string,
	requestIndex int,
	phase string,
	model string,
	turnWriter llmRepo.TurnWriter,
	provider domainllm.GenerationStatsQuerier,
	logger *slog.Logger,
	isCancelled bool,
) *EnrichGenerationJob {
	// Choose starting backoff based on use case
	startingBackoff := normalCompletionStartingBackoff
	if isCancelled {
		startingBackoff = cancellationStartingBackoff
	}

	return &EnrichGenerationJob{
		turnID:       turnID,
		generationID: generationID,
		requestIndex: requestIndex,
		phase:        phase,
		model:        model,
		turnWriter:   turnWriter,
		provider:     provider,
		logger:       logger,
		isCancelled:  isCancelled,
		attempt:      0,
		backoffDelay: startingBackoff,
	}
}

// Execute queries OpenRouter API and enriches the generation record.
// Returns error if retry needed (404), nil if finalized successfully or non-retryable error.
func (j *EnrichGenerationJob) Execute(ctx context.Context) error {
	j.attempt++

	// Apply exponential backoff before attempt (except first attempt)
	if j.attempt > 1 {
		select {
		case <-time.After(j.backoffDelay):
			// Backoff complete
		case <-ctx.Done():
			return ctx.Err()
		}
		// Double backoff for next retry
		j.backoffDelay *= 2
	}

	j.logger.Debug("attempting generation stats query",
		"turn_id", j.turnID,
		"generation_id", j.generationID,
		"attempt", j.attempt,
		"backoff_ms", j.backoffDelay.Milliseconds(),
	)

	// Query OpenRouter /generation API with 2-second timeout per attempt
	apiCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	stats, err := j.provider.QueryGenerationStats(apiCtx, j.generationID)
	if err != nil {
		j.lastError = err.Error()

		// Check if this is a 404 "not found" error (OpenRouter eventual consistency)
		if strings.Contains(err.Error(), "HTTP 404") || strings.Contains(err.Error(), "not found") {
			j.logger.Debug("generation stats not yet available, will retry",
				"turn_id", j.turnID,
				"generation_id", j.generationID,
				"attempt", j.attempt,
				"error", err,
			)
			// Return error to trigger retry (Retryable() checks attempt count)
			return fmt.Errorf("generation not indexed yet (attempt %d): %w", j.attempt, err)
		}

		// Other errors (auth, network, etc.) - give up immediately
		j.logger.Error("non-retryable error querying generation stats",
			"turn_id", j.turnID,
			"generation_id", j.generationID,
			"attempt", j.attempt,
			"error", err,
		)

		// Persist failed enrichment record so we know why it failed
		failedRecord := &llmModels.GenerationRecord{
			ID:                j.generationID,
			RequestIndex:      j.requestIndex,
			Phase:             j.phase,
			Model:             j.model,
			Finalized:         true, // Mark as finalized even on failure
			FinalizeAttempts:  j.attempt,
			FinalizeLastError: j.lastError,
		}

		if err := j.turnWriter.AppendGenerationRecord(ctx, j.turnID, failedRecord); err != nil {
			j.logger.Error("failed to persist failed generation record",
				"turn_id", j.turnID,
				"generation_id", j.generationID,
				"error", err,
			)
		}

		return nil // Don't retry non-404 errors
	}

	// Validate token counts before using them
	if stats.NativeTokensReasoning < 0 {
		j.logger.Warn("invalid negative reasoning tokens from API, clamping to 0",
			"turn_id", j.turnID,
			"generation_id", stats.ID,
			"reasoning_tokens", stats.NativeTokensReasoning,
		)
		stats.NativeTokensReasoning = 0
	}
	if stats.NativeTokensPrompt < 0 {
		j.logger.Warn("invalid negative prompt tokens from API, clamping to 0",
			"turn_id", j.turnID,
			"generation_id", stats.ID,
			"prompt_tokens", stats.NativeTokensPrompt,
		)
		stats.NativeTokensPrompt = 0
	}
	if stats.NativeTokensCompletion < 0 {
		j.logger.Warn("invalid negative completion tokens from API, clamping to 0",
			"turn_id", j.turnID,
			"generation_id", stats.ID,
			"completion_tokens", stats.NativeTokensCompletion,
		)
		stats.NativeTokensCompletion = 0
	}

	// Success! Build enriched record with COMPLETE API response
	record := &llmModels.GenerationRecord{
		ID:                     stats.ID,
		RequestIndex:           j.requestIndex,
		Phase:                  j.phase,
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
		Finalized:              true,
		FinalizeAttempts:       j.attempt,
		FinalizeLastError:      "", // Clear error on success

		// CRITICAL: Store unknown fields from API for forward compatibility
		AdditionalFields: stats.AdditionalFields,
	}

	j.logger.Debug("generation stats enrichment successful",
		"turn_id", j.turnID,
		"generation_id", j.generationID,
		"provider_name", stats.ProviderName,
		"total_cost", stats.TotalCost,
		"native_tokens_prompt", stats.NativeTokensPrompt,
		"native_tokens_completion", stats.NativeTokensCompletion,
		"attempt", j.attempt,
	)

	// Upsert-by-id (replaces partial record from processGenerationIDDiscovered)
	if err := j.turnWriter.AppendGenerationRecord(ctx, j.turnID, record); err != nil {
		return fmt.Errorf("failed to persist enriched generation record: %w", err)
	}

	// Update turn-level tokens with enriched data from OpenRouter API
	// This ensures output_tokens includes both completion AND reasoning tokens
	//
	// IDEMPOTENCY GUARANTEE:
	// - Job queue deduplicates by JobID() = "enrich_generation:{turnID}:{generationID}"
	// - Generation record persistence uses upsert-by-id (safe to re-run)
	// - Token update errors cause job retry (prevents partial completion)
	// - If token update succeeds, job completes and won't retry
	//
	// Edge case: If job runs to completion twice due to queue issues, tokens may
	// accumulate twice. This is mitigated by job queue deduplication.
	return j.updateTurnTokens(ctx, stats)
}

// JobID returns unique identifier for deduplication.
// Format: "enrich_generation:<turnID>:<generationID>"
func (j *EnrichGenerationJob) JobID() string {
	return fmt.Sprintf("enrich_generation:%s:%s", j.turnID, j.generationID)
}

// Retryable returns true if job should be retried.
// Only retry HTTP 404 errors (generation not yet indexed).
func (j *EnrichGenerationJob) Retryable() bool {
	// Only retry 404 errors
	if !strings.Contains(j.lastError, "404") {
		return false
	}

	// Different max attempts based on use case
	maxAttempts := normalCompletionMaxAttempts
	if j.isCancelled {
		maxAttempts = cancellationMaxAttempts
	}

	return j.attempt < maxAttempts
}

// JobType returns the job type for logging/monitoring.
func (j *EnrichGenerationJob) JobType() string {
	return "enrich_generation"
}

// updateTurnTokens updates turn-level token counts with enriched data from OpenRouter API.
// This method encapsulates the logic for when and how to update tokens, improving SRP.
//
// Returns error if token update fails, triggering job retry for eventual consistency.
func (j *EnrichGenerationJob) updateTurnTokens(ctx context.Context, stats *domainllm.GenerationStats) error {
	// Determine if we should update turn tokens and calculate the values
	shouldUpdate, inputTokens, outputTokens, reason := j.determineTokenUpdate(stats)

	if !shouldUpdate {
		return nil
	}

	// CRITICAL: Return error on failure to prevent job completion without token update
	// This ensures idempotency - if token update fails, job will retry
	model := stats.Model
	finishReason := stats.FinishReason
	if err := j.turnWriter.AccumulateTokensAndUpdateMetadata(
		ctx,
		j.turnID,
		&llmRepo.TurnTokenUpdate{
			InputTokens:  inputTokens,
			OutputTokens: outputTokens,
		},
		&llmRepo.TurnCompletionUpdate{
			Model:            &model,
			StopReason:       &finishReason,
			ResponseMetadata: nil, // Already updated via AppendGenerationRecord
		},
	); err != nil {
		j.logger.Error("failed to update turn tokens from OpenRouter API",
			"turn_id", j.turnID,
			"generation_id", stats.ID,
			"reason", reason,
			"input_tokens", inputTokens,
			"output_tokens", outputTokens,
			"error", err,
		)
		return fmt.Errorf("token accumulation failed for generation %s: %w", stats.ID, err)
	}

	j.logger.Info("updated turn tokens from OpenRouter API",
		"turn_id", j.turnID,
		"generation_id", stats.ID,
		"input_tokens", inputTokens,
		"output_tokens", outputTokens,
		"reason", reason,
	)

	return nil
}

// determineTokenUpdate decides whether to update turn tokens and calculates the values.
// This method implements the token update strategy, improving code clarity.
//
// Returns:
//   - shouldUpdate: whether to update turn tokens
//   - inputTokens: input tokens to accumulate (0 if already set)
//   - outputTokens: output tokens to accumulate (includes reasoning)
//   - reason: why we're updating (for logging)
func (j *EnrichGenerationJob) determineTokenUpdate(stats *domainllm.GenerationStats) (bool, int, int, string) {
	// Cancellation: Always update (replaces placeholder 0 tokens)
	if j.isCancelled && (stats.NativeTokensPrompt > 0 || stats.NativeTokensCompletion > 0) {
		inputTokens := stats.NativeTokensPrompt
		outputTokens := stats.NativeTokensCompletion + stats.NativeTokensReasoning

		if stats.NativeTokensReasoning > 0 {
			j.logger.Info("including reasoning tokens in cancellation output count",
				"turn_id", j.turnID,
				"completion_tokens", stats.NativeTokensCompletion,
				"reasoning_tokens", stats.NativeTokensReasoning,
				"total_output", outputTokens,
			)
		}

		return true, inputTokens, outputTokens, "cancellation"
	}

	// Normal completion with reasoning: Update to add reasoning tokens
	// (streaming metadata does not include reasoning tokens, only /generation API has them)
	if !j.isCancelled && stats.NativeTokensReasoning > 0 {
		inputTokens := 0                                // Already set during stream
		outputTokens := stats.NativeTokensReasoning     // ADD reasoning to existing completion tokens

		j.logger.Info("adding reasoning tokens to turn output count",
			"turn_id", j.turnID,
			"reasoning_tokens", stats.NativeTokensReasoning,
			"note", "streaming metadata lacks reasoning tokens, adding from /generation API",
		)

		return true, inputTokens, outputTokens, "reasoning_tokens"
	}

	// No token update needed
	return false, 0, 0, ""
}
