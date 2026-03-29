package streaming

import (
	"context"
	"fmt"

	mstream "github.com/haowjy/meridian-stream-go"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/streaming/agui"
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

	currentState := se.getState()
	isDraining := currentState == StateDrainMetadata

	// If in DrainMetadata state (soft cancel), skip tool continuation - just cleanup
	// Turn status is already "cancelled" (set by InterruptTurn)
	// Client was already notified + disconnected by handleSoftCancel(); no completion SSE event needed
	if isDraining {
		se.logger.Info("stream completed after soft cancel, tokens saved",
			"turn_id", se.turnID,
			"generation_id", metadata.GenerationID,
		)

		se.Terminate(ReasonSoftCancelDrained, TerminateOpts{Metadata: metadata})
		return nil
	}

	// Check if we have collected tools to execute
	if len(se.collectedTools) > 0 && se.toolRegistry != nil {
		// Tool continuation is a non-terminal boundary. Persist this request's metadata
		// and settle billing before running tools/starting the next provider request.
		if metadata.StopReason == "tool_use" {
			se.persistAndSettleToolUseRequest(ctx, metadata)
		}

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
				se.handleError(ctx, send, fmt.Errorf("failed to persist error tool results at hard limit: %w", err), false)
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
	if se.interjectionBuffer != nil && se.streamRuntime != nil {
		if interjection, ok := se.interjectionBuffer.DrainAndClear(); ok {
			se.logger.Info("interjection detected at no-tools completion, triggering stream switch",
				"turn_id", se.turnID,
				"interjection_length", len(interjection),
			)

			// Transfer slot ownership from current executor to the successor stream.
			// SwitchStream releases it on failure; on success the new executor owns it.
			releaseSlot := se.TransferSlotRelease()

			var params *domainllm.RequestParams
			if se.req != nil {
				params = se.req.Params
			}

			// Call stream switch to create new turns and start new stream.
			result, err := se.streamRuntime.SwitchStream(ctx, &SwitchStreamInput{
				CurrentTurnID:    se.turnID,
				ThreadID:         se.threadID,
				UserID:           se.userID,
				ProjectID:        se.projectID,
				Model:            se.model,
				Provider:         se.providerName,
				Params:           params,
				ToolRegistry:     se.toolRegistry,
				SettlementMode:   se.settlementMode,
				InterjectionText: interjection,
				Reason:           "no_tools_completion",
				ReleaseSlot:      releaseSlot,
			})
			if err != nil {
				se.logger.Error("stream switch failed at completion",
					"turn_id", se.turnID,
					"error", err,
				)
				// Preserve current turn metadata even when follow-up stream switch fails.
				terminationErr := fmt.Errorf("interjection stream switch failed: %w", err)
				se.Terminate(ReasonError, TerminateOpts{
					ErrorMessage: terminationErr.Error(),
					Metadata:     metadata,
				})
				return terminationErr
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
			se.Terminate(ReasonStreamSwitch, TerminateOpts{Metadata: metadata})
			return nil
		}
	}

	// No tools to execute (or stop_reason != "tool_use"), complete the turn
	return se.completeTurn(ctx, send, metadata.StopReason, metadata)
}

// persistAndSettleToolUseRequest handles per-request metadata persistence + billing
// for non-terminal tool_use completions before the next tool round begins.
func (se *StreamExecutor) persistAndSettleToolUseRequest(ctx context.Context, metadata *domainllm.StreamMetadata) {
	if metadata == nil {
		return
	}

	tokenResult := se.finalizeTokensForTermination(ctx, ReasonCompleted, metadata)
	se.settleBillingForTermination(ctx, ReasonCompleted, metadata, tokenResult)
}

// handleError handles streaming errors.
func (se *StreamExecutor) handleError(_ context.Context, _ func(mstream.Event), err error, wasCancel bool) {
	// Keep cancellation classification for logs; terminal cleanup is centralized in Terminate.
	currentState := se.getState()
	cancelRequested := se.persistenceGuard != nil && !se.persistenceGuard.IsArmed()
	wasCancelled := wasCancel || cancelRequested || currentState == StateDrainMetadata || currentState == StateHardCancelled
	userErrorMsg := sanitizeProviderError(err)

	if wasCancelled {
		se.logger.Debug("handling stream error from cancel state",
			"turn_id", se.turnID,
			"state", currentState.String(),
			"error", err.Error(),
		)
		se.Terminate(ReasonHardCancelled, TerminateOpts{ErrorMessage: userErrorMsg})
		return
	}

	se.Terminate(ReasonError, TerminateOpts{ErrorMessage: userErrorMsg})
}

// completeTurn finalizes a fully completed turn via Terminate.
// This is called only when stop_reason != "tool_use" (or max iterations hit).
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

	// Check context budget and emit context_warning SSE event if threshold crossed.
	// Must run BEFORE RUN_FINISHED so the frontend receives the warning while the
	// connection is still open. The call is synchronous but fast (~1 ms in-memory).
	budget := se.checkBudgetAndAct(ctx, send)
	se.Terminate(ReasonCompleted, TerminateOpts{Metadata: metadata, StopReason: stopReason})

	// If collapse threshold (60%) was crossed, create a collapse_marker system turn
	// asynchronously so CM3's MessageBuilder can detect it in future conversation builds.
	// Must run after emitting RUN_FINISHED to avoid blocking the stream response.
	if budget.ShouldCollapse {
		se.createCollapseMarkerAsync(budget.UsagePercent)
	}

	return nil
}
