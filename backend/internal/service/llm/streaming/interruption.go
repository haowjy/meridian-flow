package streaming

import (
	"context"
	"strings"
	"time"

	domainllm "meridian/internal/domain/llm"
)

// InterruptTurn cancels a streaming turn.
// Behavior depends on the model's supports_streaming_cancel capability:
// - true (Anthropic): Hard cancel (stops provider, uses token count API)
// - false (some providers): Soft cancel (provider continues for accurate metadata, but stops persistence)
func (s *Service) InterruptTurn(ctx context.Context, userID string, turnID string) error {
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID); err != nil {
		return err
	}

	// Get stream from mstream registry
	stream := s.registry.Get(turnID)
	if stream == nil {
		// Stream not found - may already be complete or never started
		return nil
	}

	// Get executor for this turn
	executor := s.executorRegistry.Get(turnID)
	if executor == nil {
		// No executor found - just cancel the stream
		stream.Cancel()
		return nil
	}

	// Read executor state under lock: InterruptTurn runs on a different goroutine than workFunc.
	executor.stateMu.RLock()
	executorState := executor.state
	executor.stateMu.RUnlock()
	isNotStarted := executorState == StateNotStarted

	// Get the turn to find the model
	turn, err := s.turnReader.GetTurn(ctx, turnID)
	if err != nil {
		s.logger.Warn("failed to get turn for interrupt, falling back to cancellation without model capabilities",
			"turn_id", turnID,
			"error", err,
		)
		if isNotStarted {
			// workFunc has not started and is not consuming ctrlCh yet.
			executor.Terminate(ReasonHardCancelled, TerminateOpts{})
		} else {
			// Default to soft cancel if we can't determine model capabilities.
			// This preserves accurate token metadata when the provider ignores cancellation.
			executor.RequestSoftCancel()
		}

		// Exception to "Terminate owns terminal writes":
		// InterruptTurn runs on a different goroutine than the streaming actor, so it is the
		// source of truth for cancelled status on interrupt paths.
		// Terminate intentionally skips status updates for ReasonSoftCancelDrained,
		// ReasonHardCancelled, and ReasonSoftCancelTimeout because status is already cancelled here.
		// Update turn status to cancelled (best-effort).
		if err := s.turnWriter.UpdateTurnStatus(ctx, turnID, domainllm.TurnStatusCancelled, nil); err != nil {
			s.logger.Warn("failed to update turn status to cancelled",
				"turn_id", turnID,
				"error", err,
			)
		}
		return nil
	}

	// Check model capability
	supportsCancel := false // Default to soft cancel for unknown models (token accuracy)
	if turn.Model != nil {
		// Determine provider from model name
		provider := s.getProviderFromModel(*turn.Model)
		caps, capErr := s.capabilityRegistry.GetModelCapabilities(provider, *turn.Model)
		if capErr == nil && caps != nil {
			supportsCancel = caps.SupportsStreamingCancel
		}
	}

	// Exception to "Terminate owns terminal writes":
	// InterruptTurn runs on a different goroutine than the streaming actor, so it writes
	// cancelled status directly before requesting soft/hard cancel on the executor.
	// Terminate skips status updates for ReasonSoftCancelDrained/ReasonHardCancelled/
	// ReasonSoftCancelTimeout because this write has already happened.
	// Update turn status to cancelled.
	if err := s.turnWriter.UpdateTurnStatus(ctx, turnID, domainllm.TurnStatusCancelled, nil); err != nil {
		s.logger.Warn("failed to update turn status to cancelled",
			"turn_id", turnID,
			"error", err,
		)
	}

	// Cancel based on capability
	if isNotStarted {
		// workFunc has not started and is not consuming ctrlCh yet.
		executor.Terminate(ReasonHardCancelled, TerminateOpts{})
	} else if supportsCancel {
		// Hard cancel - stops provider stream, triggers token counting in handleError
		s.logger.Debug("hard cancel (provider supports cancellation)",
			"turn_id", turnID,
			"model", turn.Model,
		)
		executor.RequestHardCancel()
		stream.Cancel()
	} else {
		// Soft cancel - provider continues for accurate token metadata
		// Executor will persist partial text blocks and disconnect SSE clients.
		s.logger.Debug("soft cancel (provider continues for metadata)",
			"turn_id", turnID,
			"model", turn.Model,
		)
		executor.RequestSoftCancel()
	}

	// Cascade cancel to any running child threads spawned from this thread.
	// Best-effort: runs async so we don't block the interrupt response.
	// Children that are already completed are not affected (SpawnStatus check inside).
	if executor.threadID != "" {
		go s.cascadeCancelChildren(executor.threadID)
	}

	return nil
}

// cascadeCancelChildren cancels all running child thread executors for a given parent thread.
// Called asynchronously after a parent turn is interrupted. Best-effort: errors are logged but
// do not propagate (the parent interrupt has already been acknowledged to the caller).
//
// Only children with spawn_status=running are affected; completed/failed/cancelled children
// are skipped. This satisfies the requirement that already-completed children are not affected.
func (s *Service) cascadeCancelChildren(parentThreadID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	children, err := s.threadRepo.ListChildThreads(ctx, parentThreadID)
	if err != nil {
		s.logger.Warn("cascade cancel: failed to list child threads",
			"parent_thread_id", parentThreadID,
			"error", err,
		)
		return
	}

	for _, child := range children {
		// Only cancel children that are still running.
		if child.SpawnStatus == nil || *child.SpawnStatus != domainllm.SpawnStatusRunning {
			continue
		}

		// Find the child's active executor via its thread ID.
		childExecutor := s.executorRegistry.GetByThread(child.ID)
		if childExecutor == nil {
			// No active executor — child may have just finished or not yet started.
			continue
		}

		s.logger.Info("cascade cancel: interrupting child executor",
			"parent_thread_id", parentThreadID,
			"child_thread_id", child.ID,
		)
		childExecutor.RequestHardCancel()

		// Update child spawn_status to cancelled in the DB (best-effort).
		if updateErr := s.threadRepo.UpdateSpawnStatus(ctx, child.ID, domainllm.SpawnStatusCancelled, nil); updateErr != nil {
			s.logger.Warn("cascade cancel: failed to update child spawn status",
				"child_thread_id", child.ID,
				"error", updateErr,
			)
		}
	}
}

// AuthorizeTurnStream verifies the caller can connect to a turn stream.
func (s *Service) AuthorizeTurnStream(ctx context.Context, userID string, turnID string) error {
	return s.authorizer.CanAccessTurn(ctx, userID, turnID)
}

// getProviderFromModel determines the provider from a model name.
// Used for capability lookup during interruption.
func (s *Service) getProviderFromModel(model string) string {
	// Claude models are from Anthropic
	if strings.HasPrefix(model, "claude-") {
		return "anthropic"
	}
	// Lorem models are internal test models
	if strings.HasPrefix(model, "lorem-") {
		return "lorem"
	}
	// Default to openrouter for other models
	return "openrouter"
}
