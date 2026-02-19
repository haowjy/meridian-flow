package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// StreamingService defines the business logic for turn creation and streaming orchestration
// This service handles creating turns and coordinating streaming responses
// For thread session management, see ThreadService
// For reading thread history, see ThreadHistoryService
type StreamingService interface {
	// CreateTurn creates a new user turn and triggers assistant streaming response
	// Validates thread exists, prev turn exists if provided
	// Creates turn with turn blocks
	// Returns both the user turn and the created assistant turn for streaming
	// Note: Only accepts "user" role. Assistant turns are created internally
	CreateTurn(ctx context.Context, req *CreateTurnRequest) (*CreateTurnResponse, error)

	// CreateAssistantTurnDebug creates an assistant turn (DEBUG/INTERNAL USE ONLY)
	// WARNING: This method should ONLY be called by:
	// - Debug handlers (when ENVIRONMENT=dev)
	// - Internal LLM response generator (Phase 2)
	// DO NOT expose this to public API endpoints
	CreateAssistantTurnDebug(ctx context.Context, threadID string, userID string, prevTurnID *string, contentBlocks []TurnBlockInput, model string) (*llm.Turn, error)

	// BuildDebugProviderRequest builds the provider-facing request payload for a hypothetical
	// user turn without executing it (DEBUG/INTERNAL USE ONLY).
	// Used by debug HTTP endpoints to inspect the exact JSON that would be sent to
	// the underlying LLM provider library for a CreateTurn request.
	BuildDebugProviderRequest(ctx context.Context, req *CreateTurnRequest) (map[string]interface{}, error)

	// InterruptTurn cancels a streaming turn.
	// Behavior depends on the model's supports_streaming_cancel capability:
	// - true (Anthropic): Hard cancel (stops provider, uses token count API)
	// - false (some providers): Soft cancel (provider continues for accurate metadata, but stops persistence)
	// Returns nil if turn is not currently streaming.
	InterruptTurn(ctx context.Context, turnID string) error

	// UpsertInterjection adds or updates an interjection for a streaming assistant turn.
	// If the turn is actively streaming, the interjection is buffered and will be
	// injected at the next safe boundary (after tool execution or at completion).
	// If the turn is not streaming (race condition), falls back to creating a
	// follow-up user turn and starting a new assistant stream.
	UpsertInterjection(ctx context.Context, assistantTurnID string, content string, mode string) (*UpsertInterjectionResponse, error)

	// GetInterjection retrieves the current interjection state for an assistant turn.
	// Returns empty content if no interjection is buffered or turn is not streaming.
	GetInterjection(ctx context.Context, assistantTurnID string) (*GetInterjectionResponse, error)

	// ClearInterjection removes any buffered interjection for an assistant turn.
	// No-op if turn is not streaming or no interjection exists.
	ClearInterjection(ctx context.Context, assistantTurnID string) error
}

// CreateTurnRequest is the DTO for creating a new turn
//
// Thread resolution priority:
// 1. If PrevTurnID provided -> lookup its thread_id from DB (ignores ThreadID/ProjectID)
// 2. Else if ThreadID provided -> use that thread
// 3. Else if ProjectID provided -> create new thread (cold start, title from first text block)
// 4. Else -> validation error
type CreateTurnRequest struct {
	ThreadID       *string                `json:"thread_id,omitempty"`  // Optional - if nil with ProjectID, creates new thread
	ProjectID      *string                `json:"project_id,omitempty"` // Required if ThreadID is nil (for new thread creation)
	UserID         string                 `json:"-"`                    // Set by handler from auth context, not from request body
	PrevTurnID     *string                `json:"prev_turn_id,omitempty"`
	Role           string                 `json:"role"`                      // "user" only (backend generates assistant turns)
	SelectedSkills []string               `json:"selected_skills,omitempty"` // Skill names to load from DB
	TurnBlocks     []TurnBlockInput       `json:"turn_blocks,omitempty"`
	RequestParams  map[string]interface{} `json:"request_params,omitempty"` // LLM request parameters (model, temperature, thinking_enabled, system, etc.)
}

// TurnBlockInput is the DTO for content block creation
type TurnBlockInput struct {
	BlockType   string                 `json:"block_type"` // "text", "thinking", "tool_use", "tool_result", "image", "reference", "partial_reference"
	TextContent *string                `json:"text_content,omitempty"`
	Content     map[string]interface{} `json:"content,omitempty"` // JSONB for type-specific structured data
}

// CreateTurnResponse is the response DTO for CreateTurn
// Returns both the user turn and the assistant turn that was created for streaming
// If a new thread was created (cold start), the Thread field is populated
type CreateTurnResponse struct {
	Thread        *llm.Thread `json:"thread,omitempty"` // Populated when new thread was created (cold start)
	UserTurn      *llm.Turn   `json:"user_turn"`
	AssistantTurn *llm.Turn   `json:"assistant_turn"`
	StreamURL     string      `json:"stream_url"` // Convenience URL for SSE streaming
}

// UpsertInterjectionResponse is the response for UpsertInterjection.
// Mode indicates whether the interjection was queued (streaming) or created (fallback).
type UpsertInterjectionResponse struct {
	Mode string `json:"mode"` // "queued" if buffered, "created" if fallback

	// Fields for mode="queued" (interjection buffered while streaming)
	AssistantTurnID string `json:"assistantTurnId,omitempty"`
	Content         string `json:"content,omitempty"`
	Length          int    `json:"length,omitempty"`

	// Fields for mode="created" (fallback: turn not streaming, created new turns)
	UserTurn      *llm.Turn `json:"userTurn,omitempty"`
	NewAssistantTurn *llm.Turn `json:"assistantTurn,omitempty"`
	StreamURL     string    `json:"streamUrl,omitempty"`
}

// GetInterjectionResponse is the response for GetInterjection.
type GetInterjectionResponse struct {
	AssistantTurnID string `json:"assistantTurnId"`
	IsStreaming     bool   `json:"isStreaming"`
	Content         string `json:"content"`
}
