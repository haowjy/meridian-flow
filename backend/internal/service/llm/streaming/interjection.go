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
		// Turn is streaming - buffer the interjection
		buffer := s.interjectionRegistry.GetOrCreate(assistantTurnID)

		var err error
		if mode == "replace" {
			err = buffer.Replace(content)
		} else {
			// Default to append
			err = buffer.Append(content)
		}

		if err != nil {
			return nil, err
		}

		finalContent, _ := buffer.Peek()
		length := buffer.Length()

		// NOTE: We intentionally do NOT emit INTERJECTION_UPDATED SSE events here.
		// SSE events are buffered in mstream and replayed on reconnect, which causes
		// stale interjection state to reappear after user clears it. Instead, the
		// frontend fetches live interjection state via GET /api/turns/{id}/interjection
		// on SSE connect.

		s.logger.Debug("interjection buffered",
			"turn_id", assistantTurnID,
			"mode", mode,
			"length", length,
		)

		return &domainllm.UpsertInterjectionResponse{
			Mode:            "queued",
			AssistantTurnID: assistantTurnID,
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
		buffer, exists := s.interjectionRegistry.Get(assistantTurnID)
		if exists {
			content, _ = buffer.Peek()
		}
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

	buffer, exists := s.interjectionRegistry.Get(assistantTurnID)
	if exists {
		buffer.Clear()
		s.logger.Debug("interjection cleared", "turn_id", assistantTurnID)
	}
	return nil
}

// createStreamSwitchFn creates a StreamSwitchFn for use during interjection injection.
// The returned function creates a new user turn (containing the interjection) and
// a new assistant turn, then starts streaming for the new assistant turn.
func (s *Service) createStreamSwitchFn(threadID, userID string, requestParams map[string]any) StreamSwitchFn {
	return func(ctx context.Context, currentAssistantTurnID string, interjection string, reason string) (*StreamSwitchResult, error) {
		s.logger.Info("stream switch triggered",
			"current_turn_id", currentAssistantTurnID,
			"reason", reason,
			"interjection_length", len(interjection),
		)

		// 1. Mark the current assistant turn as complete
		// This ensures the turn graph is consistent before creating new turns
		if err := s.turnWriter.UpdateTurnStatus(ctx, currentAssistantTurnID, domainllm.TurnStatusComplete, nil); err != nil {
			s.logger.Error("failed to complete current turn during stream switch",
				"turn_id", currentAssistantTurnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to complete current turn: %w", err)
		}

		// 2. Create follow-up turn using the existing CreateTurn flow
		// The interjection becomes a regular user message
		textContent := interjection
		resp, err := s.CreateTurn(ctx, &domainllm.CreateTurnRequest{
			ThreadID:   &threadID,
			PrevTurnID: &currentAssistantTurnID, // Chain after the (now complete) assistant turn
			UserID:     userID,
			Role:       "user",
			TurnBlocks: []domainllm.TurnBlockInput{
				{
					BlockType:   "text",
					TextContent: &textContent,
				},
			},
			RequestParams: requestParams,
		})
		if err != nil {
			s.logger.Error("failed to create follow-up turn during stream switch",
				"current_turn_id", currentAssistantTurnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to create follow-up turn: %w", err)
		}

		// Update last_viewed_turn_id to the new assistant turn
		// This ensures reload scrolls to the correct position after stream switch
		assistantTurnID := resp.AssistantTurn.ID
		if err := s.threadRepo.UpdateLastViewedTurn(ctx, threadID, userID, &assistantTurnID); err != nil {
			// Log but don't fail - bookmark update is non-critical
			s.logger.Warn("failed to update last_viewed_turn_id during stream switch",
				"thread_id", threadID,
				"turn_id", resp.AssistantTurn.ID,
				"error", err,
			)
		}

		s.logger.Info("stream switch completed",
			"prev_turn_id", currentAssistantTurnID,
			"new_user_turn_id", resp.UserTurn.ID,
			"new_assistant_turn_id", resp.AssistantTurn.ID,
			"reason", reason,
		)

		// 3. Clean up interjection buffer for the old turn
		s.interjectionRegistry.Remove(currentAssistantTurnID)

		return &StreamSwitchResult{
			UserTurn:      resp.UserTurn,
			AssistantTurn: resp.AssistantTurn,
			StreamURL:     resp.StreamURL,
		}, nil
	}
}
