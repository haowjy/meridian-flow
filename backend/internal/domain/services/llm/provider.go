package llm

import (
	"context"
	"time"

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
// Each event contains either a delta, a complete block, metadata (completion), an AG-UI event, or an error.
//
// AG-UI events (via AGUIEvent field) are the new protocol and will eventually replace Delta events.
// During the transition period, both may be emitted. The streaming executor should:
// 1. Check AGUIEvent first - if set, emit directly as SSE (new path)
// 2. Fall back to Delta processing for non-AG-UI events (legacy path)
type StreamEvent struct {
	// Delta contains incremental block content for real-time UI updates (nil if block/metadata/error)
	// LEGACY: Will be deprecated in favor of AGUIEvent for streaming content
	Delta *llm.TurnBlockDelta

	// Block contains a complete block when a block finishes streaming (nil if delta/metadata/error)
	// This is emitted once per block when streaming completes for that block.
	// The block is normalized and ready for database persistence.
	Block *llm.TurnBlock

	// Metadata contains final response data when streaming completes (nil until end)
	Metadata *StreamMetadata

	// GenerationIDDiscovered is a non-terminal metadata event emitted when generation ID is discovered
	// Emitted once per generation (on first chunk), allows early persistence
	// This is separate from Metadata which is the final event
	GenerationIDDiscovered *GenerationIDEvent

	// AGUIEvent contains an AG-UI protocol event from the library.
	// When set, this event should be serialized and emitted directly via SSE.
	// Type: events.Event from github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events
	// Use type assertion to access specific event types (e.g., *events.TextMessageContentEvent)
	// NEW: This is the preferred path for streaming events (AG-UI protocol compliant)
	AGUIEvent any

	// Error contains any error that occurred during streaming (nil if successful)
	Error error
}

// HasAGUIEvent returns true if this StreamEvent contains an AG-UI event.
func (e *StreamEvent) HasAGUIEvent() bool {
	return e.AGUIEvent != nil
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

	// GenerationID is the unique identifier for this generation (provider-specific)
	// Used for querying generation stats after cancel/timeout.
	// OpenRouter: Can be used with GET /api/v1/generation?id={GenerationID} to get native token counts.
	GenerationID string

	// ResponseMetadata contains provider-specific response data
	ResponseMetadata map[string]interface{}
}

// GenerationIDEvent contains generation metadata discovered early in the stream.
// This is emitted as soon as the provider sends the generation ID (typically first chunk),
// not at stream completion like StreamMetadata.
// Allows early persistence for cancel-via-generation enrichment.
type GenerationIDEvent struct {
	// GenerationID is the unique identifier for this generation (provider-specific)
	// OpenRouter: e.g., "gen-abc123xyz"
	GenerationID string

	// Model is the model identifier (e.g., "x-ai/grok-beta")
	Model string

	// Provider is the provider name (e.g., "openrouter")
	Provider string
}

// GenerationStatsQuerier is a capability interface for providers that support generation metadata queries.
// Only providers with generation stats APIs (like OpenRouter) should implement this.
//
// This interface allows high-level code (StreamExecutor) to query generation stats
// without depending on concrete provider types (DIP compliance).
//
// Usage:
//
//	if querier, ok := provider.(GenerationStatsQuerier); ok {
//	    stats, err := querier.QueryGenerationStats(ctx, generationID)
//	    // ... use stats
//	}
type GenerationStatsQuerier interface {
	// QueryGenerationStats fetches generation metadata for a given generation ID.
	// Returns detailed stats including provider name, native tokens, cost, etc.
	// Returns error if query fails or generation not found.
	QueryGenerationStats(ctx context.Context, generationID string) (*GenerationStats, error)
}

// GenerationCanceller is a capability interface for providers that support generation cancellation via API.
// Only providers with cancel APIs (like OpenRouter) should implement this.
//
// This interface allows high-level code (StreamExecutor) to attempt generation cancellation
// without depending on concrete provider types (DIP compliance).
//
// Note: Cancellation is best-effort and upstream-dependent:
// - OpenRouter forwards cancel to upstream provider (e.g., DeepInfra, Together)
// - If upstream supports cancel: billing stops immediately
// - If upstream doesn't support cancel: returns error, billing continues
//
// The caller should ALWAYS continue with normal flow (query GenerationStats for actual usage)
// regardless of whether cancel succeeds or fails.
//
// Usage:
//
//	if canceller, ok := provider.(GenerationCanceller); ok {
//	    err := canceller.CancelGeneration(ctx, generationID)
//	    if err != nil {
//	        // Log warning, continue with normal flow
//	    }
//	}
type GenerationCanceller interface {
	// CancelGeneration attempts to cancel an ongoing generation via provider API.
	// Returns error if cancel API call fails or upstream doesn't support cancellation.
	CancelGeneration(ctx context.Context, generationID string) error
}

// GenerationStats represents generation metadata from a provider.
// Domain-level type - provider adapters convert library types to this.
// Maps 1:1 to llm.GenerationRecord for persistence.
type GenerationStats struct {
	// ID is the unique generation identifier (e.g., "gen-abc123xyz")
	ID string

	// Model is the model that was used (e.g., "x-ai/grok-beta")
	Model string

	// ProviderName is the upstream provider that actually served the request
	// (e.g., "DeepInfra", "OpenAI", "Together")
	ProviderName string

	// NativeTokensPrompt is the number of input tokens (native tokenizer)
	NativeTokensPrompt int

	// NativeTokensCompletion is the number of output tokens (native tokenizer)
	NativeTokensCompletion int

	// NativeTokensReasoning is the number of reasoning tokens (o1, DeepSeek-R1, MiniMax)
	// These are separate from completion tokens and essential for accurate cost tracking
	NativeTokensReasoning int

	// NativeTokensCached is the number of cached tokens (cache hits)
	NativeTokensCached int

	// TotalCost is the cost of this generation in USD
	TotalCost float64

	// FinishReason indicates why generation stopped
	// (e.g., "stop", "length", "tool_use", "content_filter")
	FinishReason string

	// CreatedAt is the timestamp when the generation was created
	CreatedAt time.Time

	// UpstreamID is the provider's request ID (e.g., OpenAI's request ID)
	UpstreamID string

	// Latency is the request latency in milliseconds
	Latency int64

	// Cancelled indicates whether this generation was cancelled via provider API
	Cancelled bool

	// AdditionalFields preserves unknown fields from provider API
	// Forward compatibility when provider adds new fields
	AdditionalFields map[string]interface{}
}
