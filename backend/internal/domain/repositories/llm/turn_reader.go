package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// TurnReader defines read operations for turn data access
// Used by components that only need to query turns/blocks
type TurnReader interface {
	// GetTurn retrieves a turn by ID
	// Returns domain.ErrNotFound if not found
	GetTurn(ctx context.Context, turnID string) (*llm.Turn, error)

	// GetRootTurns retrieves all root turns for a specific chat
	// Root turns are turns where prev_turn_id IS NULL
	// Returns empty slice if no root turns found
	GetRootTurns(ctx context.Context, chatID string) ([]llm.Turn, error)

	// GetTurnBlocks retrieves all turn blocks for a turn
	// Returns blocks ordered by sequence
	GetTurnBlocks(ctx context.Context, turnID string) ([]llm.TurnBlock, error)

	// GetTurnBlocksForTurns retrieves blocks for multiple turns in a single query (batch operation)
	// Returns a map of turn ID to blocks, ordered by sequence within each turn
	// This eliminates N+1 query problems when loading many turns with their blocks
	GetTurnBlocksForTurns(ctx context.Context, turnIDs []string) (map[string][]llm.TurnBlock, error)
}
