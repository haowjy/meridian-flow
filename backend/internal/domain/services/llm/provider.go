package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// LLMProvider defines the interface that all LLM providers must implement.
// This abstraction allows supporting multiple providers (Anthropic, OpenAI, etc.)
// while maintaining a consistent interface for the ResponseGenerator.
type LLMProvider interface {
	// GenerateResponse generates a complete response from the LLM provider (blocking).
	// It takes conversation context (messages) and returns content blocks.
	// Used for non-streaming scenarios or as fallback.
	GenerateResponse(ctx context.Context, req *GenerateRequest) (*GenerateResponse, error)

	// StreamResponse generates a streaming response from the LLM provider (non-blocking).
	// Returns a channel that emits TurnBlockDelta events as they arrive.
	// The channel is closed when streaming completes or encounters an error.
	// Metadata (tokens, stop_reason) is sent in the final StreamMetadata event.
	//
	// Usage:
	//   events, err := provider.StreamResponse(ctx, req)
	//   if err != nil { return err }
	//   for event := range events {
	//     if event.Error != nil { handle error }
	//     if event.Delta != nil { process delta }
	//     if event.Metadata != nil { streaming complete }
	//   }
	StreamResponse(ctx context.Context, req *GenerateRequest) (<-chan StreamEvent, error)

	// Name returns the provider name (e.g., "anthropic", "openai")
	Name() string

	// SupportsModel returns true if the provider supports the given model.
	SupportsModel(model string) bool
}

// GenerateRequest contains the parameters for an LLM generation request.
type GenerateRequest struct {
	// Messages contains the conversation history.
	// Each message has a Role (user/assistant) and TurnBlocks.
	Messages []Message

	// Model is the model identifier (e.g., "claude-haiku-4-5-20251001")
	Model string

	// Params contains all request parameters (temperature, max_tokens, thinking settings, etc.)
	// Provider adapters extract what they support from this unified struct.
	// Stored as-is in database for complete audit trail.
	Params *llm.RequestParams
}

// Message represents a single message in the conversation.
type Message struct {
	// Role is either "user" or "assistant"
	Role string

	// Content is the list of content blocks for this message
	Content []*llm.TurnBlock
}

// GenerateResponse contains the LLM provider's response.
type GenerateResponse struct {
	// Content is the list of content blocks returned by the provider
	Content []*llm.TurnBlock

	// Model is the model that was used (may differ from request if aliased)
	Model string

	// InputTokens is the number of tokens in the input
	InputTokens int

	// OutputTokens is the number of tokens in the output
	OutputTokens int

	// StopReason indicates why generation stopped (e.g., "end_turn", "max_tokens")
	// Stored separately for easy querying
	StopReason string

	// ResponseMetadata contains provider-specific response data
	// Examples: stop_sequence, cache_creation_input_tokens, cache_read_input_tokens, etc.
	// Stored as JSONB in database
	ResponseMetadata map[string]interface{}
}

// StreamEvent represents a single event in a streaming response.
// Each event contains either a delta, metadata (completion), or an error.
type StreamEvent struct {
	// Delta contains incremental block content (nil if metadata or error)
	Delta *llm.TurnBlockDelta

	// Metadata contains final response data when streaming completes (nil until end)
	Metadata *StreamMetadata

	// Error contains any error that occurred during streaming (nil if successful)
	Error error
}

// StreamMetadata contains completion information sent when streaming finishes.
// This is sent as the final event before the channel closes.
type StreamMetadata struct {
	// Model is the model that was used (may differ from request if aliased)
	Model string

	// InputTokens is the number of tokens in the input
	InputTokens int

	// OutputTokens is the number of tokens in the output
	OutputTokens int

	// StopReason indicates why generation stopped (e.g., "end_turn", "max_tokens", "tool_use")
	StopReason string

	// ResponseMetadata contains provider-specific response data
	ResponseMetadata map[string]interface{}
}
