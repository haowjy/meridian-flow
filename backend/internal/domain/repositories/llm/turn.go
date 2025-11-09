package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// TurnRepository defines the interface for turn data access
type TurnRepository interface {
	// CreateTurn creates a new turn in the conversation
	// Validates that prev_turn_id exists if provided
	CreateTurn(ctx context.Context, turn *llm.Turn) error

	// GetTurn retrieves a turn by ID
	// Returns domain.ErrNotFound if not found
	GetTurn(ctx context.Context, turnID string) (*llm.Turn, error)

	// GetTurnPath retrieves the full conversation path from a turn to the root
	// Returns turns in order from root to the specified turn
	// Uses recursive CTE with depth limit
	GetTurnPath(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetTurnChildren retrieves all child turns (branches) of a prev turn
	// Returns empty slice if no children found
	GetTurnChildren(ctx context.Context, prevTurnID string) ([]llm.Turn, error)

	// GetRootTurns retrieves all root turns for a specific chat
	// Root turns are turns where prev_turn_id IS NULL
	// Returns empty slice if no root turns found
	GetRootTurns(ctx context.Context, chatID string) ([]llm.Turn, error)

	// UpdateTurnStatus updates a turn's status and completion time
	// Used for streaming state management
	UpdateTurnStatus(ctx context.Context, turnID, status string, completedAt *llm.Turn) error

	// UpdateTurn updates a turn's fields (status, tokens, model, error, etc.)
	UpdateTurn(ctx context.Context, turn *llm.Turn) error

	// CreateContentBlocks creates content blocks for a turn (user or assistant)
	// Blocks are inserted in sequence order
	// Handles JSONB metadata for assistant blocks (thinking, tool_use)
	CreateContentBlocks(ctx context.Context, blocks []llm.ContentBlock) error

	// GetContentBlocks retrieves all content blocks for a turn
	// Returns blocks ordered by sequence
	GetContentBlocks(ctx context.Context, turnID string) ([]llm.ContentBlock, error)
}
