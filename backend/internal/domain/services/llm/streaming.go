package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// StreamingService defines the business logic for turn creation and streaming orchestration
// This service handles creating turns and coordinating streaming responses
// For chat session management, see ChatService
// For reading conversation history, see ConversationService
type StreamingService interface {
	// CreateTurn creates a new user turn and triggers assistant streaming response
	// Validates chat exists, prev turn exists if provided
	// Creates turn with turn blocks
	// Returns both the user turn and the created assistant turn for streaming
	// Note: Only accepts "user" role. Assistant turns are created internally
	CreateTurn(ctx context.Context, req *CreateTurnRequest) (*CreateTurnResponse, error)

	// CreateAssistantTurnDebug creates an assistant turn (DEBUG/INTERNAL USE ONLY)
	// WARNING: This method should ONLY be called by:
	// - Debug handlers (when ENVIRONMENT=dev)
	// - Internal LLM response generator (Phase 2)
	// DO NOT expose this to public API endpoints
	CreateAssistantTurnDebug(ctx context.Context, chatID string, userID string, prevTurnID *string, contentBlocks []TurnBlockInput, model string) (*llm.Turn, error)

	// TODO: Phase 2 - Additional streaming methods
	// Future methods to add:
	// - GetTurnExecutor(turnID string) (*TurnExecutor, error) - Get executor for SSE connection
	// - InterruptTurn(ctx, turnID) error - Cancel streaming turn
}

// CreateTurnRequest is the DTO for creating a new turn
type CreateTurnRequest struct {
	ChatID        string                 `json:"chat_id"`
	UserID        string                 `json:"-"` // Set by handler from auth context, not from request body
	PrevTurnID    *string                `json:"prev_turn_id,omitempty"`
	Role          string                 `json:"role"` // "user" only (backend generates assistant turns)
	SystemPrompt  *string                `json:"system_prompt,omitempty"`
	TurnBlocks    []TurnBlockInput       `json:"turn_blocks,omitempty"`
	RequestParams map[string]interface{} `json:"request_params,omitempty"` // LLM request parameters (model, temperature, thinking_enabled, etc.)
}

// TurnBlockInput is the DTO for content block creation
type TurnBlockInput struct {
	BlockType   string                 `json:"block_type"` // "text", "thinking", "tool_use", "tool_result", "image", "reference", "partial_reference"
	TextContent *string                `json:"text_content,omitempty"`
	Content     map[string]interface{} `json:"content,omitempty"` // JSONB for type-specific structured data
}

// CreateTurnResponse is the response DTO for CreateTurn
// Returns both the user turn and the assistant turn that was created for streaming
type CreateTurnResponse struct {
	UserTurn      *llm.Turn `json:"user_turn"`
	AssistantTurn *llm.Turn `json:"assistant_turn"`
	StreamURL     string    `json:"stream_url"` // Convenience URL for SSE streaming
}
