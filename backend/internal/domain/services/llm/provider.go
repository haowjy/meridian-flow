package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// LLMProvider defines the interface that all LLM providers must implement.
// This abstraction allows supporting multiple providers (Anthropic, OpenAI, etc.)
// while maintaining a consistent interface for the ResponseGenerator.
type LLMProvider interface {
	// GenerateResponse generates a response from the LLM provider.
	// It takes conversation context (messages) and returns content blocks.
	GenerateResponse(ctx context.Context, req *GenerateRequest) (*GenerateResponse, error)

	// Name returns the provider name (e.g., "anthropic", "openai")
	Name() string

	// SupportsModel returns true if the provider supports the given model.
	SupportsModel(model string) bool
}

// GenerateRequest contains the parameters for an LLM generation request.
type GenerateRequest struct {
	// Messages contains the conversation history.
	// Each message has a Role (user/assistant) and ContentBlocks.
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
	Content []*llm.ContentBlock
}

// GenerateResponse contains the LLM provider's response.
type GenerateResponse struct {
	// Content is the list of content blocks returned by the provider
	Content []*llm.ContentBlock

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
