package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// ConversationService defines the business logic for conversation history and navigation
// This service handles reading and navigating through turn history
// For chat session management, see ChatService
// For creating new turns, see StreamingService
type ConversationService interface {
	// GetTurnPath retrieves the conversation path from a turn to root
	// Used to build context for LLM requests
	// Returns turns in order from root to the specified turn
	GetTurnPath(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetTurnSiblings retrieves all sibling turns (including self) for a given turn
	// Siblings are turns that share the same prev_turn_id (alternative conversation branches)
	// Returns turns with blocks nested, ordered by created_at
	// Used for version browsing UI ("1 of 3" navigation)
	GetTurnSiblings(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetChatTree retrieves the lightweight tree structure for cache validation
	// Returns only turn IDs and parent relationships (no content)
	// Performance: <100ms even for 1000+ turns
	// Used by frontend to detect gaps, new branches, and structural changes
	GetChatTree(ctx context.Context, chatID, userID string) (*llm.ChatTree, error)

	// GetPaginatedTurns retrieves turns and blocks in paginated fashion
	// Follows path-based navigation (prev_turn_id chains)
	// Direction: "before" (history), "after" (future/branches), "both" (split limit)
	// fromTurnID: starting point (optional - defaults to chat.last_viewed_turn_id)
	// Returns turns with blocks plus has_more flags for pagination
	GetPaginatedTurns(ctx context.Context, chatID, userID string, fromTurnID *string, limit int, direction string, updateLastViewed bool) (*llm.PaginatedTurnsResponse, error)
}
