// Package tokens provides token estimation for interrupted LLM streams.
// Each provider can implement their own estimation strategy via the TokenEstimator interface.
package tokens

import "context"

// TokenEstimator estimates token counts for interrupted streams.
// Each provider can implement their own estimation strategy.
//
// Implementations should be thread-safe as they may be called from multiple goroutines.
type TokenEstimator interface {
	// EstimateOutputTokens returns estimated output tokens for the given content.
	// Returns (tokens, nil) on success, or (0, error) if estimation fails.
	//
	// The model parameter is the model ID being used (e.g., "claude-haiku-4-5").
	// The content parameter is the accumulated text content from the stream.
	EstimateOutputTokens(ctx context.Context, model string, content string) (int, error)

	// SupportsModel returns true if this estimator can handle the given model.
	// Used by the registry to select the appropriate estimator.
	SupportsModel(model string) bool
}
