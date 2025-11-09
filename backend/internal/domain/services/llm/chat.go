package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// ChatService defines the business logic for chat operations
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

	// DeleteChat soft-deletes a chat
	// Validates user has access
	DeleteChat(ctx context.Context, chatID, userID string) error

	// CreateTurn creates a new user turn (client message only)
	// Validates chat exists, prev turn exists if provided
	// Creates turn with content blocks
	// Note: Only accepts "user" role. Assistant turns are created internally
	// by the LLM response generator (Phase 2 - not yet implemented)
	CreateTurn(ctx context.Context, req *CreateTurnRequest) (*llm.Turn, error)

	// GetTurnPath retrieves the conversation path from a turn to root
	// Used to build context for LLM requests
	GetTurnPath(ctx context.Context, turnID string) ([]llm.Turn, error)

	// GetTurnChildren retrieves all branches from a prev turn
	// Used to display branching conversation UI
	GetTurnChildren(ctx context.Context, prevTurnID string) ([]llm.Turn, error)

	// CreateAssistantTurnDebug creates an assistant turn (DEBUG/INTERNAL USE ONLY)
	// WARNING: This method should ONLY be called by:
	// - Debug handlers (when ENVIRONMENT=dev)
	// - Internal LLM response generator (Phase 2)
	// DO NOT expose this to public API endpoints
	CreateAssistantTurnDebug(ctx context.Context, chatID string, userID string, prevTurnID *string, contentBlocks []ContentBlockInput, model string) (*llm.Turn, error)

	// TODO: Phase 2 - LLM Integration
	// Future methods to add:
	// - StreamTurnResponse(ctx, turnID) - SSE streaming endpoint
	// - UpdateTurnStatus(ctx, turnID, status) - Update turn status during streaming
	// - AppendContentBlock(ctx, turnID, block) - Append block during streaming
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

// CreateTurnRequest is the DTO for creating a new turn
type CreateTurnRequest struct {
	ChatID        string              `json:"chat_id"`
	UserID        string              `json:"-"` // Set by handler from auth context, not from request body
	PrevTurnID    *string             `json:"prev_turn_id,omitempty"`
	Role          string              `json:"role"` // "user" only (backend generates assistant turns)
	SystemPrompt  *string             `json:"system_prompt,omitempty"`
	ContentBlocks []ContentBlockInput `json:"content_blocks,omitempty"`
}

// ContentBlockInput is the DTO for content block creation
type ContentBlockInput struct {
	BlockType   string                 `json:"block_type"` // "text", "thinking", "tool_use", "tool_result", "image", "reference", "partial_reference"
	TextContent *string                `json:"text_content,omitempty"`
	Content     map[string]interface{} `json:"content,omitempty"` // JSONB for type-specific structured data
}
