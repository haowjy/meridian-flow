package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// TurnWriter defines write operations for turn data access
// Used by components that only need to create or update turns/blocks
type TurnWriter interface {
	// CreateTurn creates a new turn in the conversation
	// Validates that prev_turn_id exists if provided
	CreateTurn(ctx context.Context, turn *llm.Turn) error

	// CreateTurnBlock creates a single turn block for a turn
	// Used during streaming accumulation (writes one block at a time)
	CreateTurnBlock(ctx context.Context, block *llm.TurnBlock) error

	// CreateTurnBlocks creates multiple turn blocks for a turn (batch operation)
	// Blocks are inserted in sequence order
	// Handles JSONB metadata for assistant blocks (thinking, tool_use)
	CreateTurnBlocks(ctx context.Context, blocks []llm.TurnBlock) error

	// UpdateTurnStatus updates a turn's status and completion time
	// Used for streaming state management
	UpdateTurnStatus(ctx context.Context, turnID, status string, completedAt *llm.Turn) error

	// UpdateTurn updates a turn's fields (status, tokens, model, error, etc.)
	UpdateTurn(ctx context.Context, turn *llm.Turn) error

	// UpdateTurnError updates a turn's error message and sets status to "error"
	// Used during streaming error handling
	UpdateTurnError(ctx context.Context, turnID, errorMsg string) error

	// UpdateTurnMetadata updates a turn's metadata fields (model, tokens, stop_reason, etc.)
	// Used when streaming completes to store final metadata
	UpdateTurnMetadata(ctx context.Context, turnID string, metadata map[string]interface{}) error

	// UpsertPartialTextBlock creates or updates a partial text block
	// Used during streaming interruption to persist accumulated text
	// Uses ON CONFLICT to handle both insert (first partial) and update (more text accumulated)
	UpsertPartialTextBlock(ctx context.Context, block *llm.TurnBlock) error
}
