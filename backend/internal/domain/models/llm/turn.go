package llm

import (
	"time"
)

// Turn represents a single turn in a conversation (user or assistant)
// Turns form a tree structure via prev_turn_id for branching conversations
type Turn struct {
	ID           string     `json:"id" db:"id"`
	ChatID       string     `json:"chat_id" db:"chat_id"`
	PrevTurnID   *string    `json:"prev_turn_id,omitempty" db:"prev_turn_id"`
	Role         string     `json:"role" db:"role"` // "user" or "assistant"
	SystemPrompt *string    `json:"system_prompt,omitempty" db:"system_prompt"`
	Status       string     `json:"status" db:"status"` // "pending", "streaming", "waiting_subagents", "complete", "cancelled", "error"
	Error        *string    `json:"error,omitempty" db:"error"`
	Model        *string    `json:"model,omitempty" db:"model"` // LLM model used for assistant turns
	InputTokens  *int       `json:"input_tokens,omitempty" db:"input_tokens"`
	OutputTokens *int       `json:"output_tokens,omitempty" db:"output_tokens"`
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
	CompletedAt  *time.Time `json:"completed_at,omitempty" db:"completed_at"`

	// LLM Request/Response Metadata (JSONB columns)
	RequestParams    map[string]interface{} `json:"request_params,omitempty" db:"request_params"`       // All request parameters (temperature, max_tokens, thinking settings, etc.)
	StopReason       *string                `json:"stop_reason,omitempty" db:"stop_reason"`             // Why generation stopped ("end_turn", "max_tokens", "stop_sequence", etc.)
	ResponseMetadata map[string]interface{} `json:"response_metadata,omitempty" db:"response_metadata"` // Provider-specific response data (stop_sequence, cache tokens, etc.)

	// Computed fields (not stored in DB)
	ContentBlocks []ContentBlock `json:"content_blocks,omitempty"`
}
