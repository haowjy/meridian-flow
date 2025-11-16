package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// TurnNavigator defines navigation operations for turn data access
// Used by components that need to traverse conversation paths and siblings
type TurnNavigator interface {
	// GetTurnPath retrieves the full conversation path from a turn to the root
	// Returns turns in order from root to the specified turn
	// Uses recursive CTE with depth limit
	GetTurnPath(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetTurnSiblings retrieves all sibling turns (including self) for a given turn
	// Siblings are turns that share the same prev_turn_id (alternative conversation branches)
	// Returns turns with blocks nested, ordered by created_at
	GetTurnSiblings(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetSiblingsForTurns retrieves sibling turn IDs for multiple turns in a single query (batch operation)
	// Returns a map of turn ID to sibling IDs (turns with same prev_turn_id)
	// Siblings are other turns that share the same prev_turn_id (alternative conversation branches)
	GetSiblingsForTurns(ctx context.Context, turnIDs []string) (map[string][]string, error)

	// GetPaginatedTurns retrieves turns and blocks for a chat in paginated fashion
	// Follows path-based navigation (prev_turn_id chains)
	// Direction: "before" (follow prev_turn_id backwards), "after" (follow children forward), "both" (split limit)
	// When direction is "after" and multiple children exist, follows the most recent child (latest created_at)
	// fromTurnID: starting point (optional - defaults to chat.last_viewed_turn_id)
	// Returns turns with blocks in a single response, plus has_more flags for pagination
	GetPaginatedTurns(ctx context.Context, chatID, userID string, fromTurnID *string, limit int, direction string) (*llm.PaginatedTurnsResponse, error)
}
