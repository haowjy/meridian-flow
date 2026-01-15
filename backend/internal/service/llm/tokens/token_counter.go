// Package tokens provides token counting for interrupted LLM streams.
// Each provider can implement their own counting strategy via the TokenCounter interface.
package tokens

import "context"

// TokenCounter counts exact tokens for interrupted streams using provider APIs.
// Each provider can implement their own counting strategy (e.g., Anthropic's count_tokens API).
//
// Implementations should be thread-safe as they may be called from multiple goroutines.
type TokenCounter interface {
	// CountOutputTokens returns exact output token counts for the given content.
	// Returns (tokens, nil) on success, or (0, error) if counting fails.
	//
	// The model parameter is the model ID being used (e.g., "claude-haiku-4-5").
	// The content parameter is the accumulated text content from the stream.
	CountOutputTokens(ctx context.Context, model string, content string) (int, error)

	// SupportsModel returns true if this token counter can handle the given model.
	// Used by the registry to select the appropriate token counter.
	SupportsModel(model string) bool
}
