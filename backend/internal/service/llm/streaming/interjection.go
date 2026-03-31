package streaming

import (
	"context"
	"fmt"

	domainllm "meridian/internal/domain/llm"
)

// UpsertInterjection adds or updates an interjection for a streaming assistant turn.
// If the turn is actively streaming, the interjection is buffered.
// If not streaming (race condition), falls back to creating follow-up turns.
func (s *Service) UpsertInterjection(ctx context.Context, userID string, assistantTurnID string, content string, mode string) (*domainllm.UpsertInterjectionResponse, error) {
	if err := s.authorizer.CanAccessTurn(ctx, userID, assistantTurnID); err != nil {
		return nil, err
	}

	// Check if executor exists (turn is actively streaming)
	executor := s.executorRegistry.Get(assistantTurnID)

	if executor != nil {
		targetTurnID, held, err := s.interjectionRouter.Route(assistantTurnID, content, mode)
		if err != nil {
			return nil, err
		}

		// v1 adapter stores content in the returned buffer. Forwarder-backed phases
		// continue to expose this API so GET/CLEAR can inspect active turn state.
		buffer := s.interjectionRouter.Register(targetTurnID)

		finalContent, _ := buffer.Peek()
		length := buffer.Length()

		// NOTE: We intentionally do NOT emit INTERJECTION_UPDATED SSE events here.
		// SSE events are buffered in mstream and replayed on reconnect, which causes
		// stale interjection state to reappear after user clears it. Instead, the
		// frontend fetches live interjection state via GET /api/turns/{id}/interjection
		// on SSE connect.

		s.logger.Debug("interjection buffered",
			"requested_turn_id", assistantTurnID,
			"target_turn_id", targetTurnID,
			"mode", mode,
			"held", held,
			"length", length,
		)

		return &domainllm.UpsertInterjectionResponse{
			Mode:            "queued",
			AssistantTurnID: targetTurnID,
			Content:         finalContent,
			Length:          length,
		}, nil
	}

	// Turn is not streaming - fallback path
	// This handles the race condition where stream ends just before interjection arrives
	s.logger.Debug("interjection fallback: turn not streaming, creating follow-up turns",
		"turn_id", assistantTurnID,
	)

	// Get the original turn to find thread context
	turn, err := s.turnReader.GetTurn(ctx, assistantTurnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get turn for interjection fallback: %w", err)
	}

	// Get thread to find project and user
	// Use GetThreadByIDOnly since we're in an internal context (not user-scoped)
	thread, err := s.threadRepo.GetThreadByIDOnly(ctx, turn.ThreadID)
	if err != nil {
		return nil, fmt.Errorf("failed to get thread for interjection fallback: %w", err)
	}

	// Create follow-up turn using the existing CreateTurn flow
	// The interjection becomes a regular user message
	textContent := content
	resp, err := s.CreateTurn(ctx, &domainllm.CreateTurnRequest{
		ThreadID:   &turn.ThreadID,
		PrevTurnID: &assistantTurnID, // Chain after the (now complete) assistant turn
		UserID:     thread.UserID,
		Role:       "user",
		TurnBlocks: []domainllm.TurnBlockInput{
			{
				BlockType:   "text",
				TextContent: &textContent,
			},
		},
		// Inherit request params from original assistant turn if available
		RequestParams: turn.RequestParams,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create follow-up turn: %w", err)
	}

	return &domainllm.UpsertInterjectionResponse{
		Mode:             "created",
		UserTurn:         resp.UserTurn,
		NewAssistantTurn: resp.AssistantTurn,
		StreamURL:        resp.StreamURL,
	}, nil
}

// GetInterjection retrieves the current interjection state for an assistant turn.
func (s *Service) GetInterjection(ctx context.Context, userID string, assistantTurnID string) (*domainllm.GetInterjectionResponse, error) {
	if err := s.authorizer.CanAccessTurn(ctx, userID, assistantTurnID); err != nil {
		return nil, err
	}

	// Check if executor exists (turn is actively streaming)
	executor := s.executorRegistry.Get(assistantTurnID)
	isStreaming := executor != nil

	var content string
	if isStreaming {
		buffer := s.interjectionRouter.Register(assistantTurnID)
		content, _ = buffer.Peek()
	}

	return &domainllm.GetInterjectionResponse{
		AssistantTurnID: assistantTurnID,
		IsStreaming:     isStreaming,
		Content:         content,
	}, nil
}

// ClearInterjection removes any buffered interjection for an assistant turn.
func (s *Service) ClearInterjection(ctx context.Context, userID string, assistantTurnID string) error {
	if err := s.authorizer.CanAccessTurn(ctx, userID, assistantTurnID); err != nil {
		return err
	}

	if s.executorRegistry.Get(assistantTurnID) != nil {
		buffer := s.interjectionRouter.Register(assistantTurnID)
		buffer.Clear()
		s.logger.Debug("interjection cleared", "turn_id", assistantTurnID)
	}
	return nil
}
