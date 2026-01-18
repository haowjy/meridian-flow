package streaming

import (
	"context"
	"errors"
	"fmt"

	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/tokens"
)

// handleCompletion handles successful stream completion
func (se *StreamExecutor) handleCompletion(ctx context.Context, send func(mstream.Event), metadata *domainllm.StreamMetadata) error {
	// No need to finalize accumulator - complete blocks are received directly from library
	// and persisted in processCompleteBlock()

	// Use request model as fallback if provider doesn't send it in metadata
	// This prevents validation errors when OpenRouter or other providers omit model in streaming responses
	if metadata.Model == "" {
		metadata.Model = se.model
	}

	// Capture generation ID for potential token stats query on timeout
	// OpenRouter provides this in streaming metadata for querying native token counts
	if metadata.GenerationID != "" {
		se.setGenerationID(metadata.GenerationID)
	}

	// Use TokenFinalizer to get the best available tokens
	// This handles: provider tokens, OpenRouter API fallback, token counter fallback
	currentState := se.getState()
	isDraining := currentState == StateDrainMetadata

	if se.tokenFinalizer != nil {
		var reason tokens.FinalizeReason
		if isDraining {
			reason = tokens.ReasonSoftCancel
		} else {
			reason = tokens.ReasonCompletion
		}

		result, err := se.tokenFinalizer.Finalize(ctx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          metadata.Model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: se.cancelTextSnapshot,
			Reason:         reason,
			ProviderTokens: &tokens.ProviderTokens{
				InputTokens:  metadata.InputTokens,
				OutputTokens: metadata.OutputTokens,
			},
		})
		if err == nil {
			metadata.InputTokens = result.InputTokens
			metadata.OutputTokens = result.OutputTokens
			if !result.IsFinal {
				se.logger.Debug("using finalized tokens",
					"turn_id", se.turnID,
					"input_tokens", result.InputTokens,
					"output_tokens", result.OutputTokens,
					"source", result.Source,
				)
			}
		}
	}

	// Always save token metadata (even for cancelled streams)
	// This ensures accurate billing even when user cancels mid-stream
	if err := se.updateTurnMetadata(ctx, metadata); err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to update turn metadata: %w", err))
		return err
	}

	// Persist OpenRouter generation record (if applicable)
	// This captures provider name, native tokens, and cost for each LLM request
	if err := se.persistOpenRouterGenerationRecord(ctx, metadata); err != nil {
		// Log error but don't fail the request - generation metadata is supplemental
		se.logger.Warn("failed to persist OpenRouter generation record",
			"error", err,
			"turn_id", se.turnID,
			"generation_id", se.getGenerationID(),
		)
	}

	// If in DrainMetadata state (soft cancel), skip tool continuation - just cleanup
	// Turn status is already "cancelled" (set by InterruptTurn)
	// Token metadata was saved above by updateTurnMetadata()
	// Client was already notified + disconnected by handleSoftCancel(); no completion SSE event needed
	if isDraining {
		// Transition to Completed state
		se.transitionTo(StateCompleted)

		se.logger.Info("stream completed after soft cancel, tokens saved",
			"turn_id", se.turnID,
			"input_tokens", metadata.InputTokens,
			"output_tokens", metadata.OutputTokens,
		)

		// Call cleanup callback if registered
		if se.onCleanup != nil {
			se.onCleanup()
		}

		return nil
	}

	// Check if we have collected tools to execute
	if len(se.collectedTools) > 0 && se.toolRegistry != nil {
		// Check hard limit to prevent infinite loops
		// (soft limit will be handled in executeToolsAndContinue via user message)
		hardLimit := se.maxToolRounds * 2
		if se.toolIteration >= hardLimit {
			se.logger.Warn("hard limit reached, creating error tool_results and allowing final response",
				"tool_iteration", se.toolIteration,
				"hard_limit", hardLimit,
				"collected_tools", len(se.collectedTools),
			)

			// Create error tool_result blocks for each pending tool_use
			// This ensures every tool_use has a corresponding tool_result (required by Claude API)
			errMsg := fmt.Sprintf("Tool execution limit reached (%d rounds). Please provide your final answer based on the information gathered so far.", hardLimit)
			if err := se.persistErrorToolResults(ctx, send, errMsg); err != nil {
				se.handleError(ctx, send, fmt.Errorf("failed to persist error tool results at hard limit: %w", err))
				return err
			}

			// Allow LLM to process one more response to wrap up gracefully
			// The error tool_results are now persisted, so executeToolsAndContinueWithLimit
			// will load them and let the LLM respond to them
			return se.executeToolsAndContinueWithLimit(ctx, send)
		}

		// Execute tools and continue streaming
		// Soft limit notification will be injected if needed in executeToolsAndContinue
		se.logger.Info("executing collected tools",
			"tool_count", len(se.collectedTools),
			"iteration", se.toolIteration,
		)
		return se.executeToolsAndContinue(ctx, send)
	}

	// No tools to execute (or stop_reason != "tool_use"), complete the turn
	return se.completeTurn(ctx, send, metadata.StopReason, metadata)
}

// handleError handles streaming errors
func (se *StreamExecutor) handleError(_ context.Context, send func(mstream.Event), err error) {
	// Use deadline to prevent blocking if DB is slow/unresponsive during cleanup
	// Background context because original context may already be cancelled
	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Check if we were in a cancel state
	currentState := se.getState()
	wasCancelled := currentState == StateDrainMetadata || currentState == StateHardCancelled

	// Use TokenFinalizer to count tokens for any interruption (cancel, error, timeout)
	// Do this BEFORE persisting partial blocks to capture all accumulated text
	if se.tokenFinalizer != nil {
		accumulatedText := se.getAccumulatedText()
		// Use cancel-time snapshot if accumulator was cleared by handleSoftCancel
		if accumulatedText == "" && se.cancelTextSnapshot != "" {
			accumulatedText = se.cancelTextSnapshot
		}

		var reason tokens.FinalizeReason
		if wasCancelled {
			reason = tokens.ReasonHardCancel
		} else {
			reason = tokens.ReasonError
		}

		result, finalizeErr := se.tokenFinalizer.Finalize(persistCtx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          se.model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: accumulatedText,
			Reason:         reason,
			ProviderTokens: nil, // No provider tokens on error
		})
		if finalizeErr != nil {
			se.logger.Warn("failed to finalize tokens for interrupted stream",
				"error", finalizeErr,
			)
		} else if updateErr := se.persistTokenMetadata(persistCtx, result, ""); updateErr != nil {
			se.logger.Warn("failed to save finalized tokens",
				"error", updateErr,
			)
		} else if result != nil && (result.InputTokens > 0 || result.OutputTokens > 0) {
			se.logger.Debug("finalized tokens for interrupted stream",
				"input_tokens", result.InputTokens,
				"output_tokens", result.OutputTokens,
				"source", result.Source,
				"error", err.Error(),
			)
		}
	}

	// Persist any accumulated partial text blocks BEFORE marking turn as error
	se.persistPartialBlocks(persistCtx)

	// For OpenRouter: Enqueue /generation query for authoritative tokens (even on cancel)
	// This is critical because token counting may not be available immediately
	// Only do this for cancellations (hard-cancel or soft-cancel drain metadata)
	isCancelState := currentState == StateHardCancelled || currentState == StateDrainMetadata
	if isCancelState {
		generationID := se.getGenerationID()
		if generationID != "" && se.jobQueue != nil {
			querier, ok := se.provider.(domainllm.GenerationStatsQuerier)
			if ok {
				// Determine phase based on request index
				phase := "initial"
				if se.requestIndex > 0 {
					phase = "tool_continue"
				}

				// Create and enqueue enrichment job (isCancelled: true for longer retry window)
				job := jobs.NewEnrichGenerationJob(
					se.turnID,
					generationID,
					se.requestIndex,
					phase,
					se.model,
					se.turnRepo,
					querier,
					se.logger,
					true, // isCancelled: true (use longer retry window)
				)

				if err := se.jobQueue.Enqueue(job); err != nil {
					se.logger.Error("failed to enqueue generation enrichment job after cancel",
						"turn_id", se.turnID,
						"generation_id", generationID,
						"error", err,
					)
				} else {
					se.logger.Debug("enqueued generation enrichment job after cancel",
						"turn_id", se.turnID,
						"generation_id", generationID,
					)
				}
			}
		}
	}

	// Detect if this is a user cancellation (don't show error toast for these)
	// Check both: state-based (wasCancelled) and error-based (context.Canceled)
	// Bug fix: Previously only error-based check was used for SSE event, causing
	// hard cancel ("hard cancelled by user" error) to be misclassified as non-cancel
	// IMPORTANT: context.DeadlineExceeded is a TIMEOUT ERROR, not user cancellation
	// Only context.Canceled indicates user-initiated cancellation
	isContextCancelled := errors.Is(err, context.Canceled)
	isCancelled := wasCancelled || isContextCancelled

	// Update turn status in database
	// IMPORTANT: Skip UpdateTurnError if cancelled (soft/hard cancel case)
	// InterruptTurn already set status to "cancelled" - don't override it with "error"
	if isCancelled {
		se.logger.Debug("skipping UpdateTurnError for cancelled stream (status already cancelled)",
			"turn_id", se.turnID,
			"was_cancelled_state", wasCancelled,
			"context_cancelled", isContextCancelled,
		)
	} else {
		// Only update turn status to "error" for actual errors (not user cancellations)
		if updateErr := se.turnRepo.UpdateTurnError(persistCtx, se.turnID, err.Error()); updateErr != nil {
			se.logger.Error("failed to update turn error", "error", updateErr)
		}
	}

	// Emit AG-UI RUN_ERROR event before turn_error
	// This signals to AG-UI compliant frontends that the run encountered an error
	errorMsg := err.Error()
	if errorMsg == "" {
		errorMsg = "Unknown error occurred"
	}
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitRunError(errorMsg)
	}

	// Send turn_error event (legacy protocol - kept for backward compatibility)
	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:         se.turnID,
		Error:          errorMsg,
		IsCancelled:    isCancelled, // Now correctly true for both state-based and error-based cancels
		LastBlockIndex: nil,         // Could be determined from DB if needed
	})

	// Call cleanup callback if registered
	if se.onCleanup != nil {
		se.onCleanup()
	}
}

// completeTurn marks the turn as complete and sends turn_complete event.
// This is called ONLY when stop_reason != "tool_use" (or max iterations hit).
// The turn remains "streaming" during all continuation rounds.
// metadata can be nil (e.g., when max_tool_rounds is hit before next stream)
func (se *StreamExecutor) completeTurn(
	ctx context.Context,
	send func(mstream.Event),
	stopReason string,
	metadata *domainllm.StreamMetadata,
) error {
	se.logger.Info("completing turn",
		"turn_id", se.turnID,
		"stop_reason", stopReason,
		"total_tool_iterations", se.toolIteration,
	)

	// Update turn status in database
	// NOTE: This marks the FINAL completion after all continuation rounds
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "complete", nil); err != nil {
		se.logger.Error("failed to update turn status", "error", err)
		// Continue despite error - SSE event is more important
	}

	// Emit AG-UI lifecycle events before turn_complete
	// STEP_FINISHED signals the end of the current LLM request step
	// RUN_FINISHED signals successful completion of the entire run/turn
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitStepFinished()
		se.aguiEmitter.EmitRunFinished()
	}

	// Build completion event
	completeEvent := llmModels.TurnCompleteEvent{
		TurnID:     se.turnID,
		StopReason: stopReason,
	}

	// Add metadata if available (may be nil for max_tool_rounds)
	if metadata != nil {
		completeEvent.InputTokens = metadata.InputTokens
		completeEvent.OutputTokens = metadata.OutputTokens
		completeEvent.ResponseMetadata = metadata.ResponseMetadata
	}

	// Send turn_complete SSE event (legacy protocol - kept for backward compatibility)
	se.sendEvent(send, llmModels.SSEEventTurnComplete, completeEvent)

	// Call cleanup callback if registered
	if se.onCleanup != nil {
		se.onCleanup()
	}

	return nil
}
