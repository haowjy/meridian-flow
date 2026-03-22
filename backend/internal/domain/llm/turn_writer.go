package llm

import (
	"context"
)

// TurnTokenUpdate encapsulates token counts for accumulation
// Used when updating turn-level token totals across multiple LLM requests
type TurnTokenUpdate struct {
	// InputTokens is the number of input tokens to add to the turn total
	InputTokens int

	// OutputTokens is the number of output tokens to add to the turn total
	// For reasoning-capable models, this includes both completion and reasoning tokens
	OutputTokens int
}

// TurnCompletionUpdate encapsulates completion metadata for turn updates
// Uses pointers to distinguish between "update to this value" vs "don't update"
// nil pointer = skip update, non-nil = update to this value (even if empty string)
type TurnCompletionUpdate struct {
	// Model is the model that was used (e.g., "claude-3-5-sonnet-20241022")
	// nil = keep existing value, non-nil = update to this value
	Model *string

	// StopReason indicates why generation stopped (e.g., "end_turn", "max_tokens", "tool_use")
	// nil = keep existing value, non-nil = update to this value (empty string intentional for partial updates)
	StopReason *string

	// ResponseMetadata contains provider-specific response data to merge with existing metadata
	// nil = skip JSONB merge, non-nil = merge this map into existing response_metadata
	ResponseMetadata map[string]interface{}
}

// TurnWriter defines write operations for turn data access
// Used by components that only need to create or update turns/blocks
type TurnWriter interface {
	// CreateTurn creates a new turn in the conversation
	// Validates that prev_turn_id exists if provided
	CreateTurn(ctx context.Context, turn *Turn) error

	// CreateTurnBlock creates a single turn block for a turn
	// Used during streaming accumulation (writes one block at a time)
	CreateTurnBlock(ctx context.Context, block *TurnBlock) error

	// CreateTurnBlocks creates multiple turn blocks for a turn (batch operation)
	// Blocks are inserted in sequence order
	// Handles JSONB metadata for assistant blocks (thinking, tool_use)
	CreateTurnBlocks(ctx context.Context, blocks []TurnBlock) error

	// UpdateTurnStatus updates a turn's status and completion time
	// Used for streaming state management
	UpdateTurnStatus(ctx context.Context, turnID string, status TurnStatus, completedAt *Turn) error

	// UpdateTurn updates a turn's fields (status, tokens, model, error, etc.)
	UpdateTurn(ctx context.Context, turn *Turn) error

	// UpdateTurnError updates a turn's error message and sets status to "error"
	// Used during streaming error handling
	UpdateTurnError(ctx context.Context, turnID, errorMsg string) error

	// UpdateTurnMetadata updates a turn's metadata fields (model, tokens, stop_reason, etc.)
	// Used when streaming completes to store final metadata
	UpdateTurnMetadata(ctx context.Context, turnID string, metadata map[string]interface{}) error

	// AccumulateTokensAndUpdateMetadata atomically accumulates tokens and updates completion metadata
	// Single SQL statement ensures consistency - tokens and metadata update together or not at all
	// Used during tool continuation to sum tokens across multiple LLM requests
	//
	// tokens: Token counts to add to turn totals (required)
	// completion: Completion metadata to update (required, but individual fields can be nil to skip update)
	//   - Model/StopReason: nil = keep existing, non-nil = update to this value
	//   - ResponseMetadata: nil = skip JSONB merge, non-nil = merge into existing
	AccumulateTokensAndUpdateMetadata(ctx context.Context, turnID string, tokens *TurnTokenUpdate, completion *TurnCompletionUpdate) error

	// UpsertPartialBlock creates or updates a partial block (text or thinking).
	// Used during streaming interruption to persist accumulated content.
	// Uses ON CONFLICT to handle both insert (first partial) and update (more content accumulated).
	UpsertPartialBlock(ctx context.Context, block *TurnBlock) error

	// AppendGenerationRecord atomically appends or updates a generation record
	// in response_metadata.openrouter.generations[] array.
	// Uses JSONB upsert-by-id: if a record with the same generation ID exists, it's replaced;
	// otherwise the new record is appended.
	// This supports both sync enrichment (complete record) and async enrichment (partial->full).
	AppendGenerationRecord(ctx context.Context, turnID string, record *GenerationRecord) error
}
