package llm

import (
	"time"
)

// Turn role constants — match the DB CHECK constraint (see migration 00038).
const (
	TurnRoleUser      = "user"
	TurnRoleAssistant = "assistant"
	TurnRoleSystem    = "system" // bookmark turns: compaction, collapse_marker
)

// TurnType constants are stored in request_params["turn_type"] for system turns.
// They identify the kind of bookmark a system turn represents.
const (
	TurnTypeCompaction    = "compaction"     // LLM-generated summary of prior turns
	TurnTypeCollapseMarker = "collapse_marker" // marks where tool results should use collapsed_content
)

// Turn represents a single turn in a conversation (user or assistant)
// Turns form a tree structure via prev_turn_id for branching conversations
type Turn struct {
	ID           string     `json:"id" db:"id"`
	ThreadID     string     `json:"thread_id" db:"thread_id"`
	PrevTurnID   *string    `json:"prev_turn_id" db:"prev_turn_id"`
	Role         string     `json:"role" db:"role"`     // "user", "assistant", or "system" (bookmark turns)
	Status       TurnStatus `json:"status" db:"status"` // "pending", "streaming", "waiting_subagents", "complete", "cancelled", "error"
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
	Blocks     []TurnBlock `json:"blocks,omitempty"`      // Content blocks for this turn
	SiblingIDs []string    `json:"sibling_ids,omitempty"` // IDs of sibling turns (same prev_turn_id)
}

// TokenUsageInfo provides token usage statistics for a turn
type TokenUsageInfo struct {
	TurnID         string   `json:"turn_id"`
	InputTokens    *int     `json:"input_tokens"`    // Tokens used for input (nil if not available)
	OutputTokens   *int     `json:"output_tokens"`   // Tokens used for output (nil if not available)
	TotalTokens    *int     `json:"total_tokens"`    // Sum of input + output (nil if either is unavailable)
	ContextLimit   *int     `json:"context_limit"`   // Model's max context window (nil if unknown)
	UsagePercent   *float64 `json:"usage_percent"`   // Percentage of context used (nil if limit unknown)
	Model          *string  `json:"model"`           // Model name
	ProviderName   *string  `json:"provider_name"`   // Provider name (derived from model or request params)
	WarningMessage *string  `json:"warning_message"` // Human-readable warning if usage is high
}

// TurnStatus represents the lifecycle state of a turn.
type TurnStatus string

const (
	TurnStatusPending          TurnStatus = "pending"
	TurnStatusStreaming        TurnStatus = "streaming"
	TurnStatusWaitingSubagents TurnStatus = "waiting_subagents"
	TurnStatusComplete         TurnStatus = "complete"
	TurnStatusCancelled        TurnStatus = "cancelled"
	TurnStatusError            TurnStatus = "error"
	TurnStatusCreditLimited    TurnStatus = "credit_limited"
)

// TurnStore defines the full interface for turn data access.
// Composed of focused interfaces for better separation of concerns (ISP compliance).
type TurnStore interface {
	TurnWriter
	TurnReader
	TurnNavigator
}

// --- Bookmark turn helpers ---

// turnType extracts the "turn_type" field from RequestParams.
// Returns "" if not set.
func (t *Turn) turnType() string {
	if t.RequestParams == nil {
		return ""
	}
	v, _ := t.RequestParams["turn_type"].(string)
	return v
}

// IsCompactionTurn returns true when this turn is an LLM-generated compaction
// bookmark (role="system", turn_type="compaction").
// Compaction turns contain a summary of prior turns in their text block; the
// MessageBuilder uses them to truncate the effective path and inject the summary.
func (t *Turn) IsCompactionTurn() bool {
	return t.Role == TurnRoleSystem && t.turnType() == TurnTypeCompaction
}

// IsCollapseMarker returns true when this turn is a collapse marker bookmark
// (role="system", turn_type="collapse_marker").
// Collapse markers signal that tool_result blocks before this point should be
// substituted with their collapsed_content when building LLM messages.
func (t *Turn) IsCollapseMarker() bool {
	return t.Role == TurnRoleSystem && t.turnType() == TurnTypeCollapseMarker
}

// IsBookmarkTurn returns true for any system bookmark turn (compaction or collapse marker).
// Bookmark turns are not included in LLM messages directly; they influence how the
// MessageBuilder processes the surrounding turns.
func (t *Turn) IsBookmarkTurn() bool {
	return t.IsCompactionTurn() || t.IsCollapseMarker()
}
