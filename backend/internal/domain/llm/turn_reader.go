package llm

import (
	"context"
)

// TurnReader defines read operations for turn data access
// Used by components that only need to query turns/blocks
type TurnReader interface {
	// GetTurn retrieves a turn by ID
	// Returns domain.ErrNotFound if not found
	GetTurn(ctx context.Context, turnID string) (*Turn, error)

	// GetRootTurns retrieves all root turns for a specific thread
	// Root turns are turns where prev_turn_id IS NULL
	// Returns empty slice if no root turns found
	GetRootTurns(ctx context.Context, threadID string) ([]Turn, error)

	// GetTurnBlocks retrieves all turn blocks for a turn
	// Returns blocks ordered by sequence
	GetTurnBlocks(ctx context.Context, turnID string) ([]TurnBlock, error)

	// GetTurnBlocksForTurns retrieves blocks for multiple turns in a single query (batch operation)
	// Returns a map of turn ID to blocks, ordered by sequence within each turn
	// This eliminates N+1 query problems when loading many turns with their blocks
	GetTurnBlocksForTurns(ctx context.Context, turnIDs []string) (map[string][]TurnBlock, error)

	// GetLastBlockSequence retrieves the highest block sequence number for a turn.
	// Returns -1 if no blocks exist for the turn.
	// Used by SSE catchup to tell reconnecting clients where to start indexing new blocks.
	GetLastBlockSequence(ctx context.Context, turnID string) (int, error)
}
