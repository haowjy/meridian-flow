package tokens

import (
	"context"
	"sync"
)

// EstimatorRegistry manages token estimators and selects the appropriate one.
// Follows Open/Closed Principle: add new estimators without modifying existing code.
//
// The registry checks estimators in order of registration - register more specific
// estimators first (e.g., Anthropic).
//
// Note: OpenRouter models should use the Generation Stats API instead of token estimation.
// The token estimator is primarily for Anthropic direct API calls.
type EstimatorRegistry struct {
	estimators []TokenEstimator
	mu         sync.RWMutex
}

// NewEstimatorRegistry creates a new estimator registry.
// Unlike before, there is no fallback - unsupported models return 0 tokens.
// OpenRouter models should use the Generation Stats API instead.
func NewEstimatorRegistry() *EstimatorRegistry {
	return &EstimatorRegistry{
		estimators: make([]TokenEstimator, 0),
	}
}

// Register adds an estimator to the registry.
// Estimators are checked in order - register more specific ones first.
//
// Example registration order:
//  1. AnthropicEstimator (specific: handles claude-* models)
//  2. OpenRouterEstimator (fallback: handles all other models)
func (r *EstimatorRegistry) Register(e TokenEstimator) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.estimators = append(r.estimators, e)
}

// EstimateOutputTokens finds the appropriate estimator and estimates tokens.
// Returns (0, nil) if content is empty or no estimator supports the model.
//
// Selection logic:
//  1. Find first registered estimator that supports the model
//  2. If no estimator found, return 0 (caller should use provider-specific API like OpenRouter Generation Stats)
func (r *EstimatorRegistry) EstimateOutputTokens(ctx context.Context, model string, content string) (int, error) {
	if content == "" {
		return 0, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	// Find first estimator that supports this model
	for _, e := range r.estimators {
		if e.SupportsModel(model) {
			return e.EstimateOutputTokens(ctx, model, content)
		}
	}

	// No estimator found - return 0
	// Caller should use provider-specific API (e.g., OpenRouter Generation Stats)
	return 0, nil
}

// SupportsModel returns true if any registered estimator supports the model.
func (r *EstimatorRegistry) SupportsModel(model string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, e := range r.estimators {
		if e.SupportsModel(model) {
			return true
		}
	}
	return false
}
