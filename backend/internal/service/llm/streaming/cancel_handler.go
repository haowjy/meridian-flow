package streaming

import (
	"context"
	"fmt"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/service/llm/tokens"
)

// RequestSoftCancel requests a "hard-like" cancel UX while allowing the provider stream
// to continue in background for accurate final token metadata.
//
// This sends a command to the streaming goroutine via ctrlCh. The streaming goroutine
// will persist partial text blocks, emit a cancellation SSE event, then disconnect clients.
//
// Idempotent: multiple calls are safe (buffered channel drops duplicates).
func (se *StreamExecutor) RequestSoftCancel() {
	// CRITICAL: Disarm persistence guard FIRST for immediate visibility.
	// This prevents the race condition where cancel is requested but
	// PersistAndClear callback has already passed the state check.
	// The atomic store is immediately visible to all goroutines.
	se.persistenceGuard.Disarm()

	select {
	case se.ctrlCh <- controlMsg{cmd: CmdSoftCancel}:
		se.logger.Debug("soft cancel command queued", "turn_id", se.turnID)
	default:
		// Channel full - cancel already requested (idempotent)
		se.logger.Debug("soft cancel command already queued (idempotent)", "turn_id", se.turnID)
	}
}

// RequestHardCancel requests immediate cancellation (for Anthropic models that support it).
// This sends a command to the streaming goroutine which will cancel the context.
func (se *StreamExecutor) RequestHardCancel() {
	// CRITICAL: Disarm persistence guard FIRST for immediate visibility.
	// Same protection as RequestSoftCancel - prevents race condition.
	se.persistenceGuard.Disarm()

	select {
	case se.ctrlCh <- controlMsg{cmd: CmdHardCancel}:
		se.logger.Debug("hard cancel command queued", "turn_id", se.turnID)
	default:
		// Channel full - cancel already requested (idempotent)
		se.logger.Debug("hard cancel command already queued (idempotent)", "turn_id", se.turnID)
	}
}

// handleTimeoutInStreamingGoroutine processes the timeout command.
// MUST be called from the streaming goroutine to preserve actor pattern.
// Returns an error to signal the streaming loop should exit.
func (se *StreamExecutor) handleTimeoutInStreamingGoroutine(send func(mstream.Event)) error {
	// Only process timeout if we're still draining metadata
	if se.state != StateDrainMetadata {
		se.logger.Debug("timeout command ignored (not in DrainMetadata state)",
			"turn_id", se.turnID,
			"current_state", se.state.String(),
		)
		return nil
	}

	// Transition to TimedOut state
	se.transitionTo(StateTimedOut)

	// CRITICAL: Cancel the provider stream to stop the HTTP connection.
	// Without this, the provider keeps streaming (goroutine leak + billing).
	se.stream.Cancel()

	se.logger.Warn("soft cancel timeout fired, forcing cleanup",
		"turn_id", se.turnID,
		"timeout", se.softCancelTimeout,
		"generation_id", se.getGenerationID(),
		"snapshot_length", len(se.cancelTextSnapshot),
	)

	// Use deadline to prevent blocking if DB is slow/unresponsive
	ctx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Use TokenFinalizer to get best-effort tokens
	if se.tokenFinalizer != nil {
		result, err := se.tokenFinalizer.Finalize(ctx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          se.model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: se.cancelTextSnapshot,
			Reason:         tokens.ReasonSoftCancelTimeout,
			ProviderTokens: nil, // No provider tokens on timeout
		})
		if err != nil {
			se.logger.Warn("token finalization failed on timeout",
				"turn_id", se.turnID,
				"error", err,
			)
		} else if updateErr := se.persistTokenMetadata(ctx, result, "soft_cancel_timeout"); updateErr != nil {
			se.logger.Warn("failed to save tokens on timeout",
				"turn_id", se.turnID,
				"error", updateErr,
			)
		}
	}

	// Transition to Errored state (terminal)
	se.transitionTo(StateErrored)

	// Emit AG-UI RUN_ERROR event for any remaining clients
	// isCancelled=true because timeout after cancel is still a cancel (not an error)
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitRunError("timeout waiting for provider metadata", true)
	}

	// Cleanup executor
	if se.onCleanup != nil {
		se.onCleanup()
	}

	// Return error to exit streaming loop
	return fmt.Errorf("soft cancel timeout")
}

// handleSoftCancel performs "hard-like" cancellation behavior for the client:
// - Persist any accumulated partial text blocks (so refresh shows what user saw)
// - Emit a cancellation SSE event (turn_error with is_cancelled)
// - Disconnect SSE clients via SoftCancel()
//
// The provider stream continues running in the background and will still produce
// final token metadata, which handleCompletion persists even when interrupted.
func (se *StreamExecutor) handleSoftCancel(send func(mstream.Event)) {
	// Use deadline to prevent blocking if DB is slow/unresponsive during partial block persistence
	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Snapshot accumulated text at cancel time for timeout/token counting.
	// IMPORTANT: This must run on the streaming goroutine to avoid concurrent map access.
	if se.cancelTextSnapshot == "" {
		se.cancelTextSnapshot = se.getAccumulatedText()
	}

	// Persist whatever text the user already saw.
	se.persistPartialBlocks(persistCtx)

	// Clear JSON accumulator too (no longer useful after cancel).
	se.jsonAccumulator = nil

	// Emit AG-UI RUN_ERROR event for AG-UI compliant frontends
	// isCancelled=true tells frontend this is a user cancel, not an error
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitRunError("cancelled", true)
	}

	// Disconnect SSE clients. Provider stream continues; executor keeps draining for metadata.
	se.stream.SoftCancel()
}
