package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// ChatRepository defines the interface for chat data access
type ChatRepository interface {
	// CreateChat creates a new chat session
	CreateChat(ctx context.Context, chat *llm.Chat) error

	// GetChat retrieves a chat by ID (scoped to user)
	// Returns domain.ErrNotFound if not found
	GetChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)

	// GetChatByIDOnly retrieves a chat by UUID only (no user scoping)
	// Used by ResourceAuthorizer when authorization is handled separately
	// Returns domain.ErrNotFound if not found
	GetChatByIDOnly(ctx context.Context, chatID string) (*llm.Chat, error)

	// ListChatsByProject retrieves all chats for a project
	// Returns empty slice if no chats found
	ListChatsByProject(ctx context.Context, projectID, userID string) ([]llm.Chat, error)

	// UpdateChat updates a chat's mutable fields (title, last_viewed_turn_id, updated_at)
	// Returns domain.ErrNotFound if not found
	UpdateChat(ctx context.Context, chat *llm.Chat) error

	// UpdateLastViewedTurn updates only the last_viewed_turn_id field
	// Returns domain.ErrNotFound if chat not found
	UpdateLastViewedTurn(ctx context.Context, chatID, userID, turnID string) error

	// DeleteChat soft-deletes a chat and returns the deleted chat object
	// Returns domain.ErrNotFound if not found or already deleted
	DeleteChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)

	// GetChatTree retrieves the lightweight tree structure of a chat for cache validation
	// Returns only turn IDs and parent relationships (no content)
	// Performance: <100ms even for 1000+ turns
	// Used by frontend to detect gaps, new branches, and structural changes
	GetChatTree(ctx context.Context, chatID, userID string) (*llm.ChatTree, error)
}
