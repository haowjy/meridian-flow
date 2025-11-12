package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// ChatService defines the business logic for chat CRUD operations
// This service handles only chat session management (create, read, update, delete)
// For conversation history and navigation, see ConversationService
// For turn creation and streaming, see StreamingService
type ChatService interface {
	// CreateChat creates a new chat session
	// Validates project exists and user has access
	CreateChat(ctx context.Context, req *CreateChatRequest) (*llm.Chat, error)

	// GetChat retrieves a chat by ID
	// Validates user has access to the chat's project
	GetChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)

	// ListChats retrieves all chats for a project
	// Validates user has access to the project
	ListChats(ctx context.Context, projectID, userID string) ([]llm.Chat, error)

	// UpdateChat updates a chat's title
	// Validates user has access
	UpdateChat(ctx context.Context, chatID, userID string, req *UpdateChatRequest) (*llm.Chat, error)

	// DeleteChat soft-deletes a chat and returns the deleted chat object
	// Validates user has access
	DeleteChat(ctx context.Context, chatID, userID string) (*llm.Chat, error)
}

// CreateChatRequest is the DTO for creating a new chat
type CreateChatRequest struct {
	ProjectID string `json:"project_id"`
	UserID    string `json:"user_id"`
	Title     string `json:"title"`
}

// UpdateChatRequest is the DTO for updating a chat
type UpdateChatRequest struct {
	Title string `json:"title"`
}
