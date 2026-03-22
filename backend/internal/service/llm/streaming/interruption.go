package streaming

import (
	"context"
	"strings"

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

	// Get the turn to find the model
	turn, err := s.turnReader.GetTurn(ctx, turnID)
	if err != nil {
		s.logger.Warn("failed to get turn for interrupt, using soft cancel (keep provider running for metadata)",
			"turn_id", turnID,
			"error", err,
		)
		// Default to soft cancel if we can't determine model capabilities.
		// This preserves accurate token metadata when the provider ignores cancellation.
		executor.RequestSoftCancel()

		// Update turn status to cancelled (best-effort)
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

	// Update turn status to cancelled
	if err := s.turnWriter.UpdateTurnStatus(ctx, turnID, domainllm.TurnStatusCancelled, nil); err != nil {
		s.logger.Warn("failed to update turn status to cancelled",
			"turn_id", turnID,
			"error", err,
		)
	}

	// Cancel based on capability
	if supportsCancel {
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

	return nil
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
