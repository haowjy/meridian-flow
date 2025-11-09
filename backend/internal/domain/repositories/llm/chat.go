package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// ChatRepository defines the interface for chat data access
type ChatRepository interface {
	// CreateChat creates a new chat session
	CreateChat(ctx context.Context, chat *llm.Chat) error

	// GetChat retrieves a chat by ID
	// Returns domain.ErrNotFound if not found
	GetChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)

	// ListChatsByProject retrieves all chats for a project
	// Returns empty slice if no chats found
	ListChatsByProject(ctx context.Context, projectID, userID string) ([]llm.Chat, error)

	// UpdateChat updates a chat's mutable fields (title, last_viewed_turn_id, updated_at)
	// Returns domain.ErrNotFound if not found
	UpdateChat(ctx context.Context, chat *llm.Chat) error

	// DeleteChat soft-deletes a chat and returns the deleted chat object
	// Returns domain.ErrNotFound if not found or already deleted
	DeleteChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)
}
