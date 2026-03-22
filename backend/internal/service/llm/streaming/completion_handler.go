package streaming

import (
	"context"
	"errors"
	"fmt"

	mstream "github.com/haowjy/meridian-stream-go"

	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/streaming/agui"
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
	if err := se.persistGenerationRecord(ctx, metadata); err != nil {
		// Log error but don't fail the request - generation metadata is supplemental
		se.logger.Warn("failed to persist OpenRouter generation record",
			"error", err,
			"turn_id", se.turnID,
			"generation_id", se.getGenerationID(),
		)
	}

	// Terminal settlement is best-effort and must never fail the user-visible turn.
	// Deferred mode marks pending billing on the generation record and lets enrichment settle later.
	se.handleFinalSettlement(ctx, metadata, "awaiting_enrichment", isDraining)

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
		// Check hard limit to prevent infinite loops (no doubling - error at maxToolRounds)
		if se.toolIteration >= se.maxToolRounds {
			se.logger.Warn("tool round limit reached, creating error tool_results and allowing final response",
				"tool_iteration", se.toolIteration,
				"max_rounds", se.maxToolRounds,
				"collected_tools", len(se.collectedTools),
			)

			// Create error tool_result blocks for each pending tool_use
			// This ensures every tool_use has a corresponding tool_result (required by Claude API)
			errMsg := fmt.Sprintf("Tool execution limit reached (%d rounds). Please provide your final answer based on the information gathered so far.", se.maxToolRounds)
			if err := se.persistErrorToolResults(ctx, send, errMsg); err != nil {
				se.handleError(ctx, send, fmt.Errorf("failed to persist error tool results at hard limit: %w", err))
				return err
			}

			se.requestIndex++ // Next provider call is the graceful completion request.
			if err := se.creditAdmissionChecker.CheckAdmission(ctx, se.userID); err != nil {
				se.logger.Warn("credit admission denied before graceful completion provider call",
					"turn_id", se.turnID,
					"user_id", se.userID,
					"request_index", se.requestIndex,
					"phase", "graceful_completion",
					"error", err,
				)
				se.handleCreditsExhausted(ctx, send, se.requestIndex, "graceful_completion")
				return nil
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

	// INTERJECTION POINT B: Check for interjection when stream completes without tools.
	// If user submitted an interjection during streaming, inject it now by
	// creating a new user turn and switching to a new assistant stream.
	if se.interjectionBuffer != nil && se.streamSwitchFn != nil {
		if interjection, ok := se.interjectionBuffer.DrainAndClear(); ok {
			se.logger.Info("interjection detected at no-tools completion, triggering stream switch",
				"turn_id", se.turnID,
				"interjection_length", len(interjection),
			)

			// Call stream switch to create new turns and start new stream
			result, err := se.streamSwitchFn(ctx, se.turnID, interjection, "no_tools_completion")
			if err != nil {
				se.logger.Error("stream switch failed at completion",
					"turn_id", se.turnID,
					"error", err,
				)
				// Emit error and return - don't complete current stream
				se.handleError(ctx, send, fmt.Errorf("interjection stream switch failed: %w", err))
				return fmt.Errorf("interjection stream switch failed: %w", err)
			}

			// Emit STREAM_SWITCH event so frontend can reconnect to new stream
			if se.aguiEmitter != nil {
				se.aguiEmitter.EmitStreamSwitch(
					se.turnID,
					agui.StreamSwitchReasonNoToolsCompletion,
					result.UserTurn,
					result.AssistantTurn,
					result.StreamURL,
				)
			}

			// End current stream cleanly - frontend will connect to new stream
			se.logger.Info("stream switch completed, ending current stream",
				"prev_turn_id", se.turnID,
				"stream_url", result.StreamURL,
			)
			se.transitionTo(StateCompleted)
			if se.onCleanup != nil {
				se.onCleanup()
			}
			return nil
		}
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
	var settlementMetadata *domainllm.StreamMetadata

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
			settlementMetadata = &domainllm.StreamMetadata{
				Model:        se.model,
				InputTokens:  result.InputTokens,
				OutputTokens: result.OutputTokens,
			}
		}
		if result != nil && (result.InputTokens > 0 || result.OutputTokens > 0) {
			se.logger.Debug("finalized tokens for interrupted stream",
				"input_tokens", result.InputTokens,
				"output_tokens", result.OutputTokens,
				"source", result.Source,
				"error", err.Error(),
			)
		}
	}

	if settlementMetadata != nil {
		se.handleFinalSettlement(persistCtx, settlementMetadata, "interrupted_stream", wasCancelled)
	}

	// Persist any accumulated partial text blocks BEFORE marking turn as error
	se.persistPartialBlocks(persistCtx)

	// Deferred providers must persist pending settlement state on all terminal paths,
	// even when token finalization cannot provide authoritative usage yet.
	isCancelState := currentState == StateHardCancelled || currentState == StateDrainMetadata
	if se.settlementMode == billing.CreditSettlementDeferredToEnrichment && settlementMetadata == nil {
		if generationID := se.getGenerationID(); generationID != "" {
			phase := "initial"
			if se.requestIndex > 0 {
				phase = "tool_continue"
			}
			se.enqueueEnrichmentSettlementJob(generationID, phase, se.model, isCancelState)
		}
		se.persistCurrentRequestPendingSettlement(persistCtx, se.model, "interrupted_stream")
	}

	// Detect if this is a user cancellation (don't show error toast for these)
	// Check both: state-based (wasCancelled) and error-based (context.Canceled)
	// Bug fix: Previously only error-based check was used for SSE event, causing
	// hard cancel ("hard cancelled by user" error) to be misclassified as non-cancel
	// IMPORTANT: context.DeadlineExceeded is a TIMEOUT ERROR, not user cancellation
	// Only context.Canceled indicates user-initiated cancellation
	isContextCancelled := errors.Is(err, context.Canceled)
	isCancelled := wasCancelled || isContextCancelled

	// Prepare user-facing error message for DB/UI.
	// Provider errors can include verbose HTML payloads (e.g., Cloudflare 502 pages).
	userErrorMsg := sanitizeProviderError(err)

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
		if updateErr := se.turnWriter.UpdateTurnError(persistCtx, se.turnID, userErrorMsg); updateErr != nil {
			se.logger.Error("failed to update turn error", "error", updateErr)
		}
	}

	// Emit AG-UI RUN_ERROR event with isCancelled flag
	// This is the primary error event - frontend uses this for cleanup and error handling
	// isCancelled distinguishes user cancellation (no error toast) from actual errors
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitRunError(userErrorMsg, isCancelled)
	}

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
	if err := se.turnWriter.UpdateTurnStatus(ctx, se.turnID, domainllm.TurnStatusComplete, nil); err != nil {
		se.logger.Error("failed to update turn status", "error", err)
		// Continue despite error - SSE event is more important
	}

	// Emit AG-UI lifecycle events
	// STEP_FINISHED signals the end of the current LLM request step
	// RUN_FINISHED signals successful completion with LLM metadata
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitStepFinished()

		// Extract token counts from metadata if available
		var inputTokens, outputTokens int
		if metadata != nil {
			inputTokens = metadata.InputTokens
			outputTokens = metadata.OutputTokens
		}

		// RUN_FINISHED includes stopReason and token counts for frontend display/tracking
		se.aguiEmitter.EmitRunFinished(stopReason, inputTokens, outputTokens)
	}

	// Call cleanup callback if registered
	if se.onCleanup != nil {
		se.onCleanup()
	}

	return nil
}
